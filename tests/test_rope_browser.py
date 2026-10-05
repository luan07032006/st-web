"""Run: python tests/test_rope_browser.py (Python Playwright + Chrome).
Independent acceptance checks for spatial pegs and a live elastic handwriting curve.
All HTTP requests and lesson saves are mocked; existing lesson data is untouched.
"""
import json
import math
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
        page.goto("http://localhost/index.html")
        page.wait_for_function("typeof boardW !== 'undefined' && boardW > 0")
        current_version = page.evaluate("InkEngine.profile.version")
        assert current_version >= 8
        page.evaluate("""() => {
          window.ropeFixture=(points,options={})=>({type:'pen',inkVersion:6,color:'#24304a',width:1.6,
            inkOptions:{...InkEngine.strokeOptions({scale:1},'pen','pen'),
              ropeLimit:1.5,ropeWindow:16,ropeBending:4},points,...options});
          window.ropeSample=(x,y,i=0)=>({x,y,p:1,pressure:0.5,tiltX:20,tiltY:10,t:i*8});
          window.ropePixels=object=>{
            const surface=document.createElement('canvas');surface.width=360;surface.height=280;
            paintObject(surface.getContext('2d'),object);return surface.toDataURL();
          };
          window.ropeResample=(points,step=0.5)=>{
            if(!points.length)return [];
            const result=[points[0].slice(0,2)];let carried=0;
            for(let i=1;i<points.length;i++){
              let a=points[i-1].slice(0,2),b=points[i].slice(0,2);
              let distance=Math.hypot(b[0]-a[0],b[1]-a[1]);
              while(distance+carried>=step&&distance>1e-9){
                const t=(step-carried)/distance;
                a=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
                result.push(a);distance=Math.hypot(b[0]-a[0],b[1]-a[1]);carried=0;
              }
              carried+=distance;
            }
            return result;
          };
          window.ropeTurning=points=>{
            let total=0,count=0;
            for(let i=1;i<points.length-1;i++){
              const a=points[i-1],b=points[i],c=points[i+1];
              const ux=b[0]-a[0],uy=b[1]-a[1],vx=c[0]-b[0],vy=c[1]-b[1];
              const denominator=Math.hypot(ux,uy)*Math.hypot(vx,vy);
              if(denominator>1e-8){total+=Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/denominator)));count++;}
            }
            return total/Math.max(1,count);
          };
        }""")

        pegs = page.evaluate("""() => {
          const object=ropeFixture([ropeSample(20,80),ropeSample(160,80,1)]);
          const centers=InkEngine.centerline(object),state=InkEngine.ropeState(object);
          const first=state.anchors[0],last=state.anchors[state.anchors.length-1];
          const gaps=state.anchors.slice(1).map((point,i)=>point.s-state.anchors[i].s);
          const prefix=JSON.stringify(state.anchors.slice(0,state.lockedCount));
          const lockedX=state.anchors[Math.max(0,state.lockedCount-1)].x;
          const curvePrefix=centers.filter(point=>point[0]<lockedX-state.spacing*2);
          const oldAnchors=state.anchors.map(point=>({...point}));
          for(let i=1;i<=20;i++)object.points.push(ropeSample(160+i*0.5,80-i*0.5,i+1));
          const after=InkEngine.ropeState(object),afterCenters=InkEngine.centerline(object);
          return {count:state.anchors.length,spacing:state.spacing,gaps,first,last,end:centers.at(-1),lockedCount:state.lockedCount,
            prefixFixed:prefix===JSON.stringify(after.anchors.slice(0,state.lockedCount)),
            curvePrefixFixed:JSON.stringify(curvePrefix)===JSON.stringify(afterCenters.slice(0,curvePrefix.length)),
            tailChanged:oldAnchors.slice(state.lockedCount,-1).some((point,i)=>{
              const next=after.anchors[state.lockedCount+i];return Math.hypot(next.x-point.x,next.y-point.y)>1e-5;
            }),maxDrift:Math.max(...after.anchors.map(point=>Math.hypot(point.x-point.sourceX,point.y-point.sourceY))),
            limit:object.inkOptions.ropeLimit};
        }""")
        assert pegs["count"] > 150 and abs(pegs["spacing"] - 0.75) < 1e-8, pegs
        assert pegs["first"]["x"] == 20 and pegs["first"]["y"] == 80 and pegs["first"]["s"] == 0, pegs
        assert pegs["end"][:2] == [160, 80] and abs(pegs["last"]["y"] - 80) < 1e-8, pegs
        assert 0 <= 160 - pegs["last"]["x"] < pegs["spacing"], pegs
        assert all(0 < gap <= pegs["spacing"] + 1e-7 for gap in pegs["gaps"]), pegs
        assert all(abs(gap - pegs["spacing"]) < 1e-7 for gap in pegs["gaps"][:-1]), pegs
        assert pegs["lockedCount"] > 100 and pegs["prefixFixed"] and pegs["curvePrefixFixed"], pegs
        assert pegs["tailChanged"] and pegs["maxDrift"] <= pegs["limit"] + 1e-7, pegs
        print("PASS dense spatial pegs, fixed first anchor, immutable committed curve and elastic trailing correction")

        pointer_forecasts = page.evaluate("""() => {
          const build=(pointerType,extra={})=>{
            const input=InkEngine.createInput({pointerType,type:'pen',scale:1,positionMode:'rope',...extra});
            const source=Array.from({length:8},(_,i)=>({x:100+i*3,y:200,time:1000+i*8,
              pressure:0.6,tiltX:30,tiltY:15}));
            const samples=source.map(point=>input.sample(point));
            return {input,source,samples,last:samples.at(-1)};
          };
          return ['mouse','touch'].map(pointerType=>{
            const moving=build(pointerType),forecast=moving.input.predict();
            const stopped=build(pointerType);stopped.input.sample({x:121,y:200,time:1064,pressure:0.6});
            const reversed=build(pointerType);reversed.input.sample({x:115,y:200,time:1064,pressure:0.6});
            const gap=build(pointerType);gap.input.sample({x:124,y:200,time:1110,pressure:0.6});
            const old=build(pointerType,{positionMode:undefined}),highlight=build(pointerType,{type:'highlight'});
            return {pointerType,forecast,last:moving.last,
              realCoordinates:moving.samples.every((point,i)=>point.x===moving.source[i].x&&point.y===moving.source[i].y),
              oldPositionFiltered:old.samples.at(-1).x<old.source.at(-1).x,
              oldForecast:old.input.predict(),stopped:stopped.input.predict(),reversed:reversed.input.predict(),
              gap:gap.input.predict(),highlight:highlight.input.predict()};
          });
        }""")
        for result in pointer_forecasts:
            assert result["realCoordinates"] and result["oldPositionFiltered"], result
            forecast, last = result["forecast"], result["last"]
            assert forecast and 0 < forecast["x"] - last["x"] <= 2.001, result
            assert abs(forecast["y"] - last["y"]) < 1e-8, result
            assert all(forecast[key] == last[key] for key in ["p", "pressure", "tiltX", "tiltY"]), result
            assert all(result[key] is None for key in ["oldForecast", "stopped", "reversed", "gap", "highlight"]), result
        print("PASS mouse and touch rope prediction follows actual coordinates, preserves metadata and stops safely")

        smoothing = page.evaluate("""() => {
          const points=Array.from({length:401},(_,i)=>{
            const x=20+i*0.4;return ropeSample(x,100+4*Math.sin((x-20)/18)+(i%2?0.9:-0.9),i);
          });
          const object=ropeFixture(points),original=JSON.stringify(points);
          const current=ropeResample(InkEngine.centerline(object));
          const legacy=ropeResample(InkEngine.centerline({...object,inkVersion:5}));
          const middle=points=>points.filter(point=>point[0]>=30&&point[0]<=170);
          const rms=points=>Math.sqrt(points.reduce((sum,point)=>sum+
            Math.pow(point[1]-100-4*Math.sin((point[0]-20)/18),2),0)/points.length);
          const span=points=>Math.max(...points.map(point=>point[1]))-Math.min(...points.map(point=>point[1]));
          return {rms:rms(middle(current)),legacyRms:rms(middle(legacy)),rawRms:0.9,
            turning:ropeTurning(middle(current)),legacyTurning:ropeTurning(middle(legacy)),
            amplitude:span(middle(current)),sourceUnchanged:original===JSON.stringify(points),
            finite:current.every(point=>point.every(Number.isFinite))};
        }""")
        assert smoothing["finite"] and smoothing["sourceUnchanged"], smoothing
        assert smoothing["rms"] < smoothing["rawRms"] * 0.45, smoothing
        assert smoothing["turning"] < smoothing["legacyTurning"] * 0.6, smoothing
        assert 6.4 <= smoothing["amplitude"] <= 9, smoothing
        print("PASS rope reduces tremor and sharp direction changes while preserving intentional letter curves")

        loops = page.evaluate("""() => {
          const circle=Array.from({length:161},(_,i)=>ropeSample(80+6*Math.cos(i/160*2*Math.PI),
            80+6*Math.sin(i/160*2*Math.PI),i));
          const eight=Array.from({length:241},(_,i)=>ropeSample(150+8*Math.sin(i/240*2*Math.PI),
            80+5*Math.sin(i/240*4*Math.PI),i));
          const u=Array.from({length:101},(_,i)=>ropeSample(220+5*Math.cos(Math.PI-i/100*Math.PI),
            80+5*Math.sin(Math.PI-i/100*Math.PI),i));
          const details=points=>{
            const centers=InkEngine.centerline(ropeFixture(points));
            const xs=centers.map(point=>point[0]),ys=centers.map(point=>point[1]);
            let area=0;
            for(let i=1;i<centers.length;i++)area+=centers[i-1][0]*centers[i][1]-centers[i][0]*centers[i-1][1];
            return {centers,width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),area:area/2,
              first:centers[0],last:centers[centers.length-1],finite:centers.every(point=>point.every(Number.isFinite))};
          };
          const a=details(circle),b=details(eight),c=details(u);
          const surface=document.createElement('canvas');surface.width=200;surface.height=150;
          const context=surface.getContext('2d');paintObject(context,ropeFixture(circle));
          return {circle:a,eight:b,u:c,loopCenterAlpha:context.getImageData(80,80,1,1).data[3],
            circleEnds:JSON.stringify(a.first.slice(0,2))===JSON.stringify([circle[0].x,circle[0].y])&&
              JSON.stringify(a.last.slice(0,2))===JSON.stringify([circle.at(-1).x,circle.at(-1).y]),
            eightSides:b.centers.some(point=>point[0]<146)&&b.centers.some(point=>point[0]>154),
            crossing:b.centers.filter(point=>Math.hypot(point[0]-150,point[1]-80)<0.8).length};
        }""")
        assert all(loops[name]["finite"] for name in ["circle", "eight", "u"]), loops
        assert loops["circleEnds"] and loops["loopCenterAlpha"] == 0, loops
        assert loops["circle"]["width"] >= 9.6 and loops["circle"]["height"] >= 9.6, loops
        assert loops["circle"]["area"] >= 80, loops
        assert loops["eight"]["width"] >= 12.8 and loops["eight"]["height"] >= 8, loops
        assert loops["eightSides"] and loops["crossing"] >= 3, loops
        assert loops["u"]["width"] >= 8 and loops["u"]["height"] >= 4, loops
        print("PASS rounded U turns, small closed letter loops and both figure-eight lobes survive smoothing")

        replay = page.evaluate("""() => {
          const points=Array.from({length:161},(_,i)=>ropeSample(30+i*0.7,130+15*Math.sin(i/19),i));
          const build=chunk=>{
            const object=ropeFixture([]);
            for(let i=0;i<points.length;i+=chunk){object.points.push(...points.slice(i,i+chunk));InkEngine.centerline(object);}
            return {object,centers:InkEngine.centerline(object),state:InkEngine.ropeState(object),pixels:ropePixels(object)};
          };
          const each=build(1),batch=build(11),once=build(points.length);
          const restored=JSON.parse(JSON.stringify(each.object));
          return {sameCenters:JSON.stringify(each.centers)===JSON.stringify(batch.centers)&&
              JSON.stringify(each.centers)===JSON.stringify(once.centers),
            sameAnchors:JSON.stringify(each.state)===JSON.stringify(batch.state)&&JSON.stringify(each.state)===JSON.stringify(once.state),
            samePixels:each.pixels===batch.pixels&&each.pixels===once.pixels,
            restored:JSON.stringify(InkEngine.centerline(restored))===JSON.stringify(each.centers)&&ropePixels(restored)===each.pixels};
        }""")
        assert all(replay.values()), replay
        print("PASS per-event, coalesced-batch and one-shot replay have identical anchors, curves, pixels and JSON reload")

        forecasts = page.evaluate("""() => {
          const points=Array.from({length:40},(_,i)=>ropeSample(40+i*1.2,190,i));
          const predicted=ropeFixture(points.map(point=>({...point}))),control=ropeFixture(points.map(point=>({...point})));
          const before=JSON.stringify(InkEngine.ropeState(predicted));
          const last=points.at(-1),preview=InkEngine.previewStroke(predicted,{...last,x:last.x+2,y:last.y+0.2,t:last.t+8});
          InkEngine.centerline(preview);ropePixels(preview);
          const untouched=before===JSON.stringify(InkEngine.ropeState(predicted));
          for(let i=1;i<=12;i++){
            const next=ropeSample(last.x-i*0.5,last.y+i*0.8,points.length+i);
            predicted.points.push({...next});control.points.push({...next});InkEngine.centerline(predicted);InkEngine.centerline(control);
          }
          return {untouched,sameAnchors:JSON.stringify(InkEngine.ropeState(predicted))===JSON.stringify(InkEngine.ropeState(control)),
            sameCenters:JSON.stringify(InkEngine.centerline(predicted))===JSON.stringify(InkEngine.centerline(control)),
            samePixels:ropePixels(predicted)===ropePixels(control),savedRealOnly:predicted.points.length===52};
        }""")
        assert all(forecasts.values()), forecasts
        print("PASS forecast pegs never contaminate actual anchors, reversal geometry or saved samples")

        transforms = page.evaluate("""() => {
          const object=ropeFixture(Array.from({length:81},(_,i)=>ropeSample(30+i,150+12*Math.sin(i/14),i)));
          const original=InkEngine.centerline(object),state=InkEngine.ropeState(object),box=bounds(object);
          scalePaperObject(object,0.5);
          const scaled=InkEngine.centerline(object),scaledState=InkEngine.ropeState(object);
          const coordinatesMatch=original.length===scaled.length&&original.every((point,i)=>
            Math.abs(scaled[i][0]-(box.x+(point[0]-box.x)*0.5))<1e-7&&
            Math.abs(scaled[i][1]-(box.y+(point[1]-box.y)*0.5))<1e-7&&Math.abs(scaled[i][2]-point[2])<1e-7);
          moveObject(object,90,40);const moved=InkEngine.centerline(object);
          const translationMatches=scaled.length===moved.length&&scaled.every((point,i)=>
            Math.abs(moved[i][0]-point[0]-90)<1e-7&&Math.abs(moved[i][1]-point[1]-40)<1e-7);
          const restored=JSON.parse(JSON.stringify(object));
          const metadata=object.points.every((point,i)=>point.pressure===0.5&&point.tiltX===20&&point.tiltY===10&&point.t===i*8);
          return {coordinatesMatch,translationMatches,metadata,
            scaledSpacing:Math.abs(scaledState.spacing-state.spacing*0.5)<1e-7,
            reload:JSON.stringify(InkEngine.centerline(restored))===JSON.stringify(moved)&&ropePixels(restored)===ropePixels(object)};
        }""")
        assert all(transforms.values()), transforms
        print("PASS proportional document scaling, movement, raw pen metadata and saved rope reconstruction")

        imported = page.evaluate("""() => {
          const inspect=last=>{
            const object=ropeFixture([ropeSample(0,0),ropeSample(last[0],last[1],1)]);
            const before=performance.now(),centers=InkEngine.centerline(object),state=InkEngine.ropeState(object);
            const surface=document.createElement('canvas');surface.width=64;surface.height=64;
            paintObject(surface.getContext('2d'),object);
            return {ms:performance.now()-before,centers:centers.length,anchors:state.anchors.length,
              lockedCount:state.lockedCount,finite:centers.every(point=>point.every(Number.isFinite))&&
                state.anchors.every(point=>[point.x,point.y,point.sourceX,point.sourceY,point.s].every(Number.isFinite))};
          };
          return {coarse:inspect([1e9,0]),extreme:inspect([1e308,-1e308])};
        }""")
        assert imported["coarse"]["ms"] < 2000 and imported["extreme"]["ms"] < 2000, imported
        assert imported["coarse"]["finite"] and 1 < imported["coarse"]["anchors"] <= 4097, imported
        assert imported["coarse"]["centers"] > 0, imported
        assert imported["extreme"]["finite"] and imported["extreme"]["centers"] == 0, imported
        assert imported["extreme"]["anchors"] == 0 and imported["extreme"]["lockedCount"] == 0, imported
        print("PASS imported giant spans use bounded work and overflow-sized coordinates draw safely")

        captured = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          view={x:0,y:0,z:1,fit:false};chooseTool('pen');draw();canvas.setPointerCapture=()=>{};
          window.ropeEvent=(type,x,y,options={})=>{
            const rect=canvas.getBoundingClientRect();
            const {time,...pointerOptions}=options;
            const event=new PointerEvent(type,{bubbles:true,pointerId:27,pointerType:'pen',button:0,
              buttons:type==='pointerup'?0:1,pressure:0.6,tiltX:30,tiltY:15,
              clientX:rect.left+view.x+x*view.z,clientY:rect.top+view.y+y*view.z,...pointerOptions});
            if(Number.isFinite(time))Object.defineProperty(event,'timeStamp',{value:time});
            canvas.dispatchEvent(event);return event;
          };
          ropeEvent('pointerdown',100,280,{time:1000});
          const beforePalm=JSON.stringify(active);
          ropeEvent('pointerdown',120,300,{pointerType:'touch',pointerId:28});
          ropeEvent('pointermove',180,300,{pointerType:'touch',pointerId:28});
          ropeEvent('pointerup',180,300,{pointerType:'touch',pointerId:28});
          const palmIgnored=beforePalm===JSON.stringify(active);
          const rect=canvas.getBoundingClientRect();
          const samples=[{x:105,y:283,time:1008},{x:108,y:286,time:1016},{x:109,y:290,time:1024}];
          const coalesced=samples.map(point=>({pointerId:27,pointerType:'pen',pressure:0.6,tiltX:30,tiltY:15,
            clientX:rect.left+view.x+point.x*view.z,clientY:rect.top+view.y+point.y*view.z,timeStamp:point.time}));
          const batch=new PointerEvent('pointermove',{bubbles:true,pointerId:27,pointerType:'pen'});
          Object.defineProperty(batch,'getCoalescedEvents',{value:()=>coalesced});canvas.dispatchEvent(batch);
          const actual=JSON.parse(JSON.stringify(active.points));
          const raw=JSON.parse(JSON.stringify(active.rawPoints));
          ropeEvent('pointerup',111,294,{time:1032,pressure:0});
          const saved=JSON.parse(JSON.stringify(objects[0]));
          return {palmIgnored,actual,raw,saved,samples};
        }""")
        assert captured["palmIgnored"] and len(captured["actual"]) == 4, captured
        assert captured["actual"][0]["x"] == 100 and captured["actual"][0]["y"] == 280, captured
        assert len(captured["raw"]) == 4, captured
        assert captured["raw"][0]["x"] == 100 and captured["raw"][0]["y"] == 280 and captured["raw"][0]["t"] == 1000
        assert all(point["x"] == expected["x"] and point["y"] == expected["y"] and point["t"] == expected["time"]
                   for point, expected in zip(captured["raw"][1:], captured["samples"])), captured
        assert all(point["pressure"] == 0.6 and point["tiltX"] == 30 and point["tiltY"] == 15
                   for point in captured["raw"][1:]), captured
        assert all(math.hypot(point["x"] - captured["saved"]["rawPoints"][point["rawIndex"]]["x"],
                             point["y"] - captured["saved"]["rawPoints"][point["rawIndex"]]["y"]) <= 0.901
                   for point in captured["saved"]["points"]), captured
        assert any(math.hypot(point["x"] - captured["saved"]["rawPoints"][point["rawIndex"]]["x"],
                             point["y"] - captured["saved"]["rawPoints"][point["rawIndex"]]["y"]) > 1e-6
                   for point in captured["saved"]["points"][1:]), captured
        assert captured["saved"]["rawPoints"][:-1] == captured["raw"], captured
        assert captured["saved"]["rawPoints"][-1]["x"] == 111 and captured["saved"]["rawPoints"][-1]["y"] == 294, captured
        assert captured["saved"]["rawPoints"][-1]["pressure"] == 0 and captured["saved"]["rawPoints"][-1]["t"] == 1032
        assert captured["saved"]["points"][-1]["p"] == captured["saved"]["points"][-2]["p"], captured
        assert captured["saved"]["inkVersion"] == current_version, captured
        page.evaluate("saveLesson()")
        assert saves[-1]["objects"][0] == captured["saved"]
        page.evaluate("undo();redo()")
        assert page.evaluate("JSON.parse(JSON.stringify(objects[0]))") == captured["saved"]
        print("PASS independent raw acquisition, adaptive display lag, coalesced stylus input, palm rejection and saved lift")

        editing = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          view={x:0,y:0,z:1,fit:false};chooseTool('pen');draw();
          ropeEvent('pointerdown',100,320,{time:2000});
          ropeEvent('pointermove',110,325,{time:2008});ropeEvent('pointermove',115,330,{time:2016});
          InkEngine.centerline(active);const points=JSON.stringify(active.points),curve=JSON.stringify(InkEngine.centerline(active));
          const rawBefore=JSON.parse(JSON.stringify(active.rawPoints));
          ropeEvent('pointerup',115,330,{time:2024,pressure:0});
          const stationary=points===JSON.stringify(objects[0].points)&&curve===JSON.stringify(InkEngine.centerline(objects[0]));
          const raw=objects[0].rawPoints;
          const rawLiftStored=JSON.stringify(raw.slice(0,-1))===JSON.stringify(rawBefore)&&
            raw.at(-1).x===115&&raw.at(-1).y===330&&raw.at(-1).pressure===0&&raw.at(-1).t===2024;
          const saved=JSON.stringify(objects);
          ropeEvent('pointerdown',220,320,{time:2100});ropeEvent('pointermove',240,340,{time:2108});
          ropeEvent('pointercancel',240,340,{time:2116});
          const cancelled=!active&&!dragging&&JSON.stringify(objects)===saved;
          const object=ropeFixture(Array.from({length:81},(_,i)=>ropeSample(100+i*2.5,400,i)));
          objects=[object];undoStack=[];redoStack=[];
          const original=JSON.stringify(InkEngine.centerline(object));chooseTool('eraser');eraserMode='stroke';
          ropeEvent('pointerdown',200,380);ropeEvent('pointermove',200,420);ropeEvent('pointerup',200,420);
          const cut=objects.length===2&&objects.every(piece=>piece.inkVersion===6&&
            InkEngine.ropeState(piece).anchors.every(anchor=>Number.isFinite(anchor.x)&&Number.isFinite(anchor.y)));
          undo();const undoRestored=objects.length===1&&JSON.stringify(InkEngine.centerline(objects[0]))===original;
          chooseTool('moveLasso');lassoMode='rectangle';
          lassoPath=[{x:140,y:370},{x:180,y:370},{x:180,y:430},{x:140,y:430}];completeLasso();
          const selected=groupSelection.length>0;chooseTool('pen');
          return {stationary,rawLiftStored,cancelled,cut,undoRestored,selected};
        }""")
        assert all(editing.values()), editing
        assert not errors, errors
        print("PASS stationary lift, cancellation, partial erasing, undo and lasso preserve rope geometry")

        preview = os.environ.get("ST_WEB_ROPE_PREVIEW")
        if preview:
            page.evaluate("""() => {
              clearBoardInteraction();objects=[];view={x:0,y:0,z:1,fit:false};
              const label=(y,text)=>objects.push({type:'text',text,x:85,y,size:18,color:'#24304a'});
              const noisy=y=>Array.from({length:901},(_,i)=>ropeSample(90+i*0.4,
                y+12*Math.sin(i/24)+(i%2?0.9:-0.9),i));
              label(110,'Nét tay có rung nhẹ');
              objects.push({...ropeFixture(noisy(165)),inkVersion:undefined,color:'#9b3b42'});
              label(235,'Nét dây căng: mốc cố định, đuôi tự nắn');
              objects.push(ropeFixture(noisy(290)));
              label(365,'Vòng chữ nhỏ được giữ tròn, nét mảnh 1,6 px');
              for(let j=0;j<6;j++)objects.push(ropeFixture(Array.from({length:161},(_,i)=>
                ropeSample(110+j*48+10*Math.cos(i/160*2*Math.PI),415+10*Math.sin(i/160*2*Math.PI),i))));
              chooseTool('pen');draw();
            }""")
            page.wait_for_timeout(100)
            page.screenshot(path=preview)
        browser.close()


if __name__ == "__main__":
    run()
