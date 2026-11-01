"""Run: python tests/test_low_latency_ink_browser.py.

Real Chrome integration with mocked HTTP/saves; no existing lesson is changed.
"""
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run():
    with sync_playwright() as playwright:
        chrome = Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe"
        browser = playwright.chromium.launch(**({"executable_path": str(chrome)} if chrome.exists() else {}))
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=2)
        errors, saves = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("sessionStorage.setItem('qh-authenticated', 'true')")

        def serve(route):
            path = unquote(urlsplit(route.request.url).path)
            if path.startswith("/api/"):
                if route.request.method == "PUT":
                    saves.append(json.loads(route.request.post_data))
                route.fulfill(content_type="application/json", body="{}")
                return
            resource = ROOT / "Frontend" / path.lstrip("/")
            if resource.is_file():
                route.fulfill(body=resource.read_bytes(), content_type=mimetypes.guess_type(str(resource))[0] or "application/octet-stream")
            else:
                route.fulfill(status=404, body="Not found")

        page.route("**/*", serve)
        page.goto("http://localhost/editor.html")
        page.evaluate("documentReady")
        page.wait_for_function("typeof boardW !== 'undefined' && boardW > 0")
        page.evaluate("""() => {
          canvas.setPointerCapture=()=>{};
          window.resetInk=(type='pen')=>{
            clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
            view={x:0,y:0,z:1,fit:false};chooseTool(type);draw();
          };
          window.sensor=(x,y,t,options={})=>{
            const r=canvas.getBoundingClientRect();
            return {pointerId:27,pointerType:'pen',clientX:r.left+view.x+x*view.z,
              clientY:r.top+view.y+y*view.z,timeStamp:t,pressure:0.6,tiltX:30,tiltY:15,...options};
          };
          window.sendInk=(type,x,y,t,options={},samples=null,predictions=null)=>{
            const q=sensor(x,y,t,options);
            const event=new PointerEvent(type,{bubbles:true,cancelable:true,button:0,
              buttons:type==='pointerup'?0:1,...q});
            Object.defineProperty(event,'timeStamp',{value:t});
            if(samples)Object.defineProperty(event,'getCoalescedEvents',{value:()=>samples});
            if(predictions)Object.defineProperty(event,'getPredictedEvents',{value:()=>predictions});
            canvas.dispatchEvent(event);
          };
          window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
          window.makeStroke=(points,type='pen',width=8,version=InkEngine.profile.version)=>({
            type,points,width,inkVersion:version,color:'#24304a',inkOptions:InkEngine.strokeOptions({},'pen',type)});
          window.inkPixels=object=>{
            const c=document.createElement('canvas');c.width=600;c.height=500;
            paintObject(c.getContext('2d'),object);return c.toDataURL();
          };
          resetInk();
        }""")

        dynamics = page.evaluate("""() => {
          const build=(pressure,step=2,dt=8,pointerType='pen',type='pen',scale=1)=>{
            const input=InkEngine.createInput({pointerType,type,scale});
            return Array.from({length:100},(_,i)=>input.sample({x:(50+i*step)/scale,y:100/scale,
              time:i*dt,pressure,tiltX:35,tiltY:20}));
          };
          const low=build(0.1),high=build(0.9),slow=build(0.6,2,20),fast=build(0.6,2,2);
          const a=build(0.6),b=build(0.6,2,8,'pen','pen',0.5);
          const input=InkEngine.createInput({pointerType:'pen',type:'pen'});
          const noisy=Array.from({length:100},(_,i)=>input.sample({x:i*3,y:100+(i%2?1.2:-1.2),time:i*4,pressure:0.6}));
          return {low:low.at(-1).p,high:high.at(-1).p,slow:slow.at(-1).p,fast:fast.at(-1).p,
            velocity:fast.at(-1).velocity,lag:Math.max(...noisy.map((p,i)=>Math.hypot(p.x-i*3,p.y-(100+(i%2?1.2:-1.2))))),
            scale:a.every((p,i)=>Math.abs(p.x-b[i].x*.5)<1e-7&&Math.abs(p.p-b[i].p)<1e-7),
            highlight:build(0.1,2,8,'pen','highlight').every(p=>p.p===1),
            finite:noisy.every(p=>['x','y','p','pressure','velocity','tiltX','tiltY','t'].every(k=>Number.isFinite(p[k])))};
        }""")
        assert dynamics["high"] > dynamics["low"] * 1.8, dynamics
        assert dynamics["slow"] > dynamics["fast"] * 1.1, dynamics
        assert dynamics["velocity"] > 0 and dynamics["lag"] <= 0.90001, dynamics
        assert all(dynamics[key] for key in ["scale", "highlight", "finite"]), dynamics
        print("PASS pressure/velocity shaping, bounded lag, zoom independence and stylus metadata")

        acquisition = page.evaluate("""async () => {
          resetInk();sendInk('pointerdown',100,230,1000);
          const samples=[sensor(110,231,1004),sensor(120,232,1008,{pressure:0.8,tiltX:45}),
            sensor(130,233,1012),sensor(999,999,1012,{pointerId:99})];
          sendInk('pointerrawupdate',130,233,1012,{},samples);
          const count=active.rawPoints.length;
          sendInk('pointermove',130,233,1012,{},samples,[sensor(133,233,1020)]);
          const unchanged=active.rawPoints.length===count;
          const actual=JSON.stringify(active.points),raw=JSON.stringify(active.rawPoints);
          const hasPreview=Boolean(start.inkPreview);
          await frame();const backing=canvas.width===Math.round(boardW*devicePixelRatio);
          await new Promise(resolve=>setTimeout(resolve,65));await frame();
          const expired=!start.inkPreview&&actual===JSON.stringify(active.points)&&raw===JSON.stringify(active.rawPoints);
          sendInk('pointerup',130,233,1024,{pressure:0});await frame();
          const saved=JSON.parse(JSON.stringify(objects[0]));
          return {count,unchanged,hasPreview,expired,backing,saved,
            stationary:saved.points[0].x===JSON.parse(actual)[0].x&&saved.points[0].y===JSON.parse(actual)[0].y
              &&saved.points.at(-1).x===JSON.parse(actual).at(-1).x&&saved.points.at(-1).y===JSON.parse(actual).at(-1).y,
            refined:saved.inkOptions.refinementVersion===3&&saved.points.every(p=>Number.isInteger(p.rawIndex)),
            raw:saved.rawPoints.map(p=>[p.x,p.y,p.t,p.pressure,p.tiltX])};
        }""")
        assert acquisition["count"] == 4, acquisition
        assert all(acquisition[k] for k in ["unchanged", "hasPreview", "expired", "backing", "stationary", "refined"]), acquisition
        assert acquisition["raw"][2] == [120, 232, 1008, 0.8, 45], acquisition
        assert acquisition["raw"][-1][:4] == [130, 233, 1024, 0], acquisition
        assert all(point["x"] <= 130 for point in acquisition["saved"]["points"]), acquisition
        page.evaluate("saveLesson()")
        page.evaluate("DocumentStore.sync(documentWorkspace.activeId)")
        page.wait_for_function("document.getElementById('saveStatus').textContent.includes('Đã lưu')")
        assert saves[-1]["objects"] == [acquisition["saved"]], saves
        replay = page.evaluate("""() => {
          const saved=JSON.stringify(objects),pixels=inkPixels(objects[0]);
          undo();const empty=objects.length===0;redo();
          const undoFixed=saved===JSON.stringify(objects)&&pixels===inkPixels(objects[0]);
          const data=validateDoc(JSON.parse(JSON.stringify(lessonData())));applyDoc(data);
          return {empty,undoFixed,reload:saved===JSON.stringify(objects)&&pixels===inkPixels(objects[0])};
        }""")
        assert all(replay.values()), replay
        print("PASS raw/coalesced deduplication, native prediction expiry, stationary lift, saves, undo and reload")

        fallback = page.evaluate("""async () => {
          resetInk();sendInk('pointerdown',100,260,2000);
          sendInk('pointermove',120,270,2008,{},[sensor(110,265,2004),sensor(120,270,2008)]);
          const count=active.rawPoints.length;
          sendInk('pointermove',130,275,2012,{},[],[]);
          const endpoint=active.rawPoints.at(-1).x===130;
          sendInk('pointercancel',130,275,2016);await frame();
          const cancelled=objects.length===0&&!active&&!dragging;
          sendInk('pointerdown',100,260,2100);sendInk('pointermove',120,270,2108);
          canvas.dispatchEvent(new PointerEvent('lostpointercapture',{pointerId:27,pointerType:'pen'}));await frame();
          return {count,endpoint,cancelled,lost:objects.length===0&&!active&&!dragging};
        }""")
        assert fallback["count"] == 3 and all(fallback[k] for k in ["endpoint", "cancelled", "lost"]), fallback
        print("PASS pointermove/empty coalesced fallback, pointercancel and unexpected capture loss")

        rendering = page.evaluate("""() => {
          const c=document.createElement('canvas');c.width=600;c.height=500;const context=c.getContext('2d');
          const coverage=x=>{
            const data=context.getImageData(x,0,1,500).data;
            let result=0;for(let i=3;i<data.length;i+=4)result+=data[i]/255;return result;
          };
          const line=makeStroke(Array.from({length:181},(_,i)=>({x:80+i,y:100,p:1})), 'pen',12);
          const originalStroke=context.stroke.bind(context);
          let strokes=0;context.stroke=()=>{strokes++;};paintObject(context,line);
          const taper={start:coverage(81),body:coverage(170),end:coverage(259)};
          context.clearRect(0,0,600,500);
          const pressure=makeStroke(Array.from({length:181},(_,i)=>({x:80+i,y:200,p:i<90?0.5:1.5})), 'pen',8);
          paintObject(context,pressure);const widths=[coverage(110),coverage(230)];
          context.clearRect(0,0,600,500);
          const highlight=makeStroke([{x:80,y:100,p:1},{x:220,y:100,p:1},{x:80,y:100,p:1}], 'highlight',3);
          paintObject(context,highlight);const alpha=[100,140,180,210].map(x=>context.getImageData(x,100,1,1).data[3]);
          const small=makeStroke([{x:60,y:60,p:1}]);context.clearRect(0,0,600,500);paintObject(context,small);
          const dot=context.getImageData(60,60,1,1).data[3];
          const loop=makeStroke(Array.from({length:101},(_,i)=>({x:120+10*Math.cos(i*Math.PI/50),y:120+10*Math.sin(i*Math.PI/50),p:1})), 'pen',1.6);
          context.clearRect(0,0,600,500);paintObject(context,loop);const hole=context.getImageData(120,120,1,1).data[3];
          const before=inkPixels(loop);moveObject(loop,40,30);
          const moved=document.createElement('canvas');moved.width=600;moved.height=500;
          const m=moved.getContext('2d');m.translate(-40,-30);paintObject(m,loop);
          const restored=JSON.parse(JSON.stringify(loop));context.stroke=originalStroke;
          return {taper,widths,alpha,dot,hole,strokes,move:before===moved.toDataURL(),reload:inkPixels(loop)===inkPixels(restored),
            legacy:[2,3,4,5,6,7,8,9,10].map(version=>{
              context.clearRect(0,0,600,500);paintObject(context,makeStroke(Array.from({length:41},(_,i)=>({x:80+i,y:100,p:1,t:i*8})), 'pen',8,version));
              return {version,coverage:coverage(100)};
            })};
        }""")
        assert rendering["strokes"] == 0 and rendering["dot"] > 200 and rendering["hole"] == 0, rendering
        assert rendering["taper"]["start"] < rendering["taper"]["body"] * 0.3, rendering
        assert rendering["taper"]["end"] < rendering["taper"]["body"] * 0.3, rendering
        assert rendering["widths"][1] > rendering["widths"][0] * 2, rendering
        assert max(rendering["alpha"]) - min(rendering["alpha"]) <= 1 and 75 <= min(rendering["alpha"]) <= 78, rendering
        assert all(rendering[k] for k in ["move", "reload"]) and all(item["coverage"] > 1 for item in rendering["legacy"]), rendering
        print("PASS filled cubic outlines, 8% taper, pressure widths, dots/loops, uniform highlighter and legacy versions 2-10")

        incremental = page.evaluate("""async () => {
          resetInk('highlight');
          const originalDraw=draw,originalPaint=InkEngine.paint,originalDrawImage=ctx.drawImage.bind(ctx);
          let fullDraws=0,fullPaths=0,copies=[];
          draw=(...args)=>{fullDraws++;return originalDraw(...args)};
          InkEngine.paint=(...args)=>{fullPaths++;return originalPaint(...args)};
          ctx.drawImage=(...args)=>{copies.push(args.length===9?[args[3],args[4]]:[canvas.width,canvas.height]);return originalDrawImage(...args)};
          sendInk('pointerdown',100,320,3000);await frame();
          fullDraws=0;fullPaths=0;copies=[];
          for(let i=1;i<=40;i++){
            sendInk('pointermove',100+i*4,320,3000+i*4);await frame();
          }
          const points=JSON.stringify(active.points);
          const moving={fullDraws,fullPaths,copies,backing:[canvas.width,canvas.height]};
          // A forecast is replaceable, including when its tip crosses existing ink.
          sendInk('pointermove',264,320,3164,{},null,[sensor(266,320,3172)]);await frame();
          sendInk('pointerup',264,320,3168,{pressure:0});
          const beforeFinalFrame=fullPaths;await frame();
          const afterFinalFrame=fullPaths;
          draw=originalDraw;InkEngine.paint=originalPaint;ctx.drawImage=originalDrawImage;
          return {moving,beforeFinalFrame,afterFinalFrame,object:objects[0],points};
        }""")
        assert incremental["moving"]["fullDraws"] == 0 and incremental["moving"]["fullPaths"] == 0, incremental
        assert incremental["moving"]["copies"] and all(
            width < incremental["moving"]["backing"][0] * 0.25
            and height < incremental["moving"]["backing"][1] * 0.25
            for width, height in incremental["moving"]["copies"]
        ), incremental
        assert incremental["beforeFinalFrame"] == 0 and incremental["afterFinalFrame"] == 1, incremental
        print("PASS moving strokes redraw only dirty rectangles; one final vector composition in requestAnimationFrame")

        continuity = page.evaluate("""async () => {
          resetInk();
          sendInk('pointerdown',100,380,4000);sendInk('pointermove',160,380,4008);await frame();
          sendInk('pointerup',160,380,4012,{pressure:0});
          // Start the next stroke before the preceding final frame is drawn.
          sendInk('pointerdown',100,420,4016);await frame();
          const fresh=inkBackdrop!==null;
          sendInk('pointermove',160,420,4024);await frame();
          sendInk('pointerup',160,420,4028,{pressure:0});await frame();
          const long=makeStroke(Array.from({length:3000},(_,i)=>({x:60+i*.15,y:150+15*Math.sin(i/40),p:1})), 'pen',1.6);
          const c=document.createElement('canvas');c.width=600;c.height=500;const context=c.getContext('2d');
          const before=performance.now();paintObject(context,long);const firstMs=performance.now()-before;
          context.clearRect(0,0,600,500);paintObject(context,long);const pixels=c.toDataURL();
          const replay={...long,points:[]},renderer=InkEngine.createLiveStroke(replay);
          for(let i=0;i<long.points.length;i+=20){replay.points.push(...long.points.slice(i,i+20));renderer.update();}
          context.clearRect(0,0,600,500);
          const liftBefore=performance.now();paintObject(context,replay);const liftMs=performance.now()-liftBefore;
          const liveMatches=pixels===c.toDataURL();
          const mask={...long,clipRegions:[[{x:60,y:100},{x:520,y:100},{x:520,y:200},{x:60,y:200}]],
            cutouts:[[{x:250,y:100},{x:280,y:100},{x:280,y:200},{x:250,y:200}]]};
          context.clearRect(0,0,600,500);paintObject(context,mask);
          const cut=context.getImageData(265,100,1,100).data.every((value,i)=>i%4!==3||value===0);
          return {fresh,count:objects.length,firstMs,liftMs,liveMatches,cut};
        }""")
        assert continuity["fresh"] and continuity["count"] == 2 and continuity["cut"] and continuity["liveMatches"], continuity
        print(f'PASS consecutive strokes, clip/cutout masks and identical 3000-sample vectors ({continuity["firstMs"]:.1f} ms load / {continuity["liftMs"]:.1f} ms lift)')

        # Trusted browser input exercises actual pointerrawupdate dispatch/capture.
        page.evaluate("resetInk();delete canvas.setPointerCapture")
        cdp = page.context.new_cdp_session(page)
        x, y = page.evaluate("[canvas.getBoundingClientRect().left+view.x+100,canvas.getBoundingClientRect().top+view.y+400]")
        for event_type, dx, force, buttons in [("mousePressed", 0, .4, 1), ("mouseMoved", 25, .8, 1), ("mouseReleased", 30, 0, 0)]:
            cdp.send("Input.dispatchMouseEvent", {"type": event_type, "x": x + dx, "y": y,
                "button": "left", "buttons": buttons, "clickCount": 1, "pointerType": "pen", "force": force, "tiltX": 35})
        page.wait_for_timeout(50)
        trusted = page.evaluate("JSON.parse(JSON.stringify(objects))")
        assert len(trusted) == 1 and trusted[0]["rawPoints"][0]["tiltX"] == 35, trusted
        assert trusted[0]["rawPoints"][-1]["pressure"] == 0, trusted
        assert not errors, errors
        print("PASS trusted Chrome stylus events and no browser errors")

        fallback_page = browser.new_page(viewport={"width": 375, "height": 812}, device_scale_factor=3)
        fallback_page.on("pageerror", lambda error: errors.append(str(error)))
        fallback_page.add_init_script("sessionStorage.setItem('qh-authenticated', 'true');window.OffscreenCanvas=undefined")
        fallback_page.route("**/*", serve)
        fallback_page.goto("http://localhost/editor.html")
        fallback_page.evaluate("documentReady")
        fallback_page.wait_for_function("typeof boardW !== 'undefined' && boardW > 0")
        compatibility = fallback_page.evaluate("""async () => {
          canvas.setPointerCapture=()=>{};objects=[];view.z=.5;draw();
          const fire=(type,x)=>{
            const r=canvas.getBoundingClientRect();canvas.dispatchEvent(new PointerEvent(type,{pointerId:7,
              pointerType:'pen',button:0,buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:.6,
              clientX:r.left+view.x+x*view.z,clientY:r.top+view.y+300*view.z}));
          };
          fire('pointerdown',300);fire('pointermove',400);
          await new Promise(resolve=>requestAnimationFrame(resolve));
          const fallback=inkStrokeSurface instanceof HTMLCanvasElement&&inkTipSurface instanceof HTMLCanvasElement;
          const backing=canvas.width===Math.round(boardW*3)&&inkStrokeSurface.width===canvas.width;
          fire('pointerup',400);await new Promise(resolve=>requestAnimationFrame(resolve));
          return {fallback,backing,count:objects.length};
        }""")
        assert compatibility["fallback"] and compatibility["backing"] and compatibility["count"] == 1, compatibility
        assert not errors, errors
        fallback_page.close()
        print("PASS mobile DPR3 and detached-canvas fallback without OffscreenCanvas")

        preview = os.environ.get("ST_WEB_INK_PREVIEW")
        if preview:
            page.evaluate("""() => {
              resetInk();
              for(let row=0;row<3;row++){
                const input=InkEngine.createInput({pointerType:'pen',type:row===2?'highlight':'pen'});
                const points=Array.from({length:300},(_,i)=>input.sample({x:90+i*1.8,
                  y:230+row*150+25*Math.sin(i/14),time:i*4,pressure:.5+.45*Math.sin(i/45)}));
                objects.push(makeStroke(points,row===2?'highlight':'pen',row===2?3:3));
              }
              draw();
            }""")
            page.screenshot(path=preview)
        browser.close()


if __name__ == "__main__":
    run()
