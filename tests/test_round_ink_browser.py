"""Run: python tests/test_round_ink_browser.py (Python Playwright + Chrome).
Round handwriting acceptance tests. HTTP and lesson saves are mocked.
The version 6 comparison keeps its original options rather than inheriting a new profile.
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
        page.goto("http://localhost/index.html")
        page.wait_for_function("typeof boardW !== 'undefined' && boardW > 0")
        page.evaluate("""() => {
          window.roundOldOptions={smoothing:0.65,streamline:0,thinning:1,simulatePressure:false,
            rounding:1.2,ropeSpacing:0.75,ropeLimit:1.5,ropeWindow:16,ropeBending:4};
          window.roundSample=(x,y,i=0,p=1)=>({x,y,p,pressure:0.5,tiltX:20,tiltY:10,t:i*8});
          window.roundObject=(points,legacy=false)=>({type:'pen',color:'#24304a',width:1.6,
            inkVersion:legacy?6:InkEngine.profile.version,
            inkOptions:legacy?{...roundOldOptions}:InkEngine.strokeOptions({scale:1},'pen','pen'),
            points:points.map(point=>({...point}))});
          window.roundResample=(points,step=0.5)=>{
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
          window.roundMetrics=(points,region=()=>true)=>{
            const sampled=roundResample(points),turns=[];
            for(let i=1;i<sampled.length-1;i++){
              const a=sampled[i-1],b=sampled[i],c=sampled[i+1];
              if(!region(b))continue;
              const ux=b[0]-a[0],uy=b[1]-a[1],vx=c[0]-b[0],vy=c[1]-b[1];
              const denominator=Math.hypot(ux,uy)*Math.hypot(vx,vy);
              if(denominator>1e-8)turns.push(Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/denominator))));
            }
            return {peak:Math.max(0,...turns),total:turns.reduce((a,b)=>a+b,0),count:turns.length};
          };
          window.roundPixels=(object,width=360,height=280)=>{
            const surface=document.createElement('canvas');surface.width=width*2;surface.height=height*2;
            const context=surface.getContext('2d');context.scale(2,2);paintObject(context,object);
            return surface.toDataURL();
          };
        }""")

        corners = page.evaluate("""() => {
          const fixtures=[{name:'steep V',vertices:[[20,80],[50,20],[80,80]],apex:[50,20]},
            {name:'hook cusp',vertices:[[20,120],[55,60],[62,120],[90,132]],apex:[55,60]}];
          return fixtures.map(fixture=>{
            const source=fixture.vertices.map((point,i)=>roundSample(...point,i));
          const analyze=legacy=>{
              const object=roundObject(source,legacy),original=JSON.stringify(object.points),centers=InkEngine.centerline(object);
              const distance=point=>Math.hypot(point[0]-fixture.apex[0],point[1]-fixture.apex[1]);
              const minY=Math.min(...centers.map(point=>point[1])),sliceY=minY+1,crossings=[];
              for(let i=1;i<centers.length;i++){
                const a=centers[i-1],b=centers[i];
                if((a[1]-sliceY)*(b[1]-sliceY)<=0&&Math.abs(b[1]-a[1])>1e-9){
                  const t=(sliceY-a[1])/(b[1]-a[1]);crossings.push(a[0]+(b[0]-a[0])*t);
                }
              }
              const equal=roundResample(centers),radii=[];
              for(let i=1;i<equal.length-1;i++){
                const a=equal[i-1],b=equal[i],c=equal[i+1];
                if(b[1]>minY+1)continue;
                const ab=Math.hypot(b[0]-a[0],b[1]-a[1]),bc=Math.hypot(c[0]-b[0],c[1]-b[1]);
                const ac=Math.hypot(c[0]-a[0],c[1]-a[1]);
                const twiceArea=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]));
                if(twiceArea>1e-9)radii.push(ab*bc*ac/(2*twiceArea));
              }
              return {...roundMetrics(centers,point=>distance(point)<12),
                apexDistance:Math.min(...centers.map(distance)),first:centers[0].slice(0,2),last:centers.at(-1).slice(0,2),
                nearApexWidth:crossings.length>=2?Math.max(...crossings)-Math.min(...crossings):0,
                localRadius:Math.min(...radii),sourceUnchanged:original===JSON.stringify(object.points),
                finite:centers.every(point=>point.every(Number.isFinite)),
                pressureMin:Math.min(...centers.map(point=>point[2])),pressureMax:Math.max(...centers.map(point=>point[2]))};
            };
            return {name:fixture.name,expectedFirst:fixture.vertices[0],expectedLast:fixture.vertices.at(-1),
              old:analyze(true),current:analyze(false)};
          });
        }""")
        jitter = page.evaluate("""() => {
          const source=Array.from({length:361},(_,i)=>{
            const x=20+i*0.45;return roundSample(x,170+9*Math.sin((x-20)/13)+(i%2?0.9:-0.9),i);
          });
          const analyze=legacy=>{
            const centers=roundResample(InkEngine.centerline(roundObject(source,legacy)))
              .filter(point=>point[0]>30&&point[0]<172);
            return {...roundMetrics(centers),rms:Math.sqrt(centers.reduce((sum,point)=>sum+
              Math.pow(point[1]-170-9*Math.sin((point[0]-20)/13),2),0)/centers.length),
              height:Math.max(...centers.map(point=>point[1]))-Math.min(...centers.map(point=>point[1]))};
          };
          return {old:analyze(true),current:analyze(false)};
        }""")

        loops = page.evaluate("""() => [3,4.5,6].map(radius=>{
          const points=Array.from({length:161},(_,i)=>roundSample(120+radius*Math.cos(i/160*2*Math.PI),
            100+radius*Math.sin(i/160*2*Math.PI),i));
          const object=roundObject(points),centers=InkEngine.centerline(object);
          let area=0;
          for(let i=1;i<centers.length;i++)area+=centers[i-1][0]*centers[i][1]-centers[i][0]*centers[i-1][1];
          const surface=document.createElement('canvas');surface.width=300;surface.height=240;
          const context=surface.getContext('2d');paintObject(context,object);
          return {radius,width:Math.max(...centers.map(point=>point[0]))-Math.min(...centers.map(point=>point[0])),
            height:Math.max(...centers.map(point=>point[1]))-Math.min(...centers.map(point=>point[1])),
            area:Math.abs(area/2),centerAlpha:context.getImageData(120,100,1,1).data[3],
            first:centers[0].slice(0,2),last:centers.at(-1).slice(0,2),
            expectedFirst:[points[0].x,points[0].y],expectedLast:[points.at(-1).x,points.at(-1).y],
            finite:centers.every(point=>point.every(Number.isFinite))};
        })""")

        replay = page.evaluate("""() => {
          const source=Array.from({length:180},(_,i)=>roundSample(25+i*0.6,130+18*Math.sin(i/16),i,
            0.86+0.28*i/179));
          const build=chunk=>{
            const object=roundObject([]);
            for(let i=0;i<source.length;i+=chunk){object.points.push(...source.slice(i,i+chunk));InkEngine.centerline(object);}
            return {object,centers:InkEngine.centerline(object),state:InkEngine.ropeState(object),pixels:roundPixels(object)};
          };
          const each=build(1),batch=build(9),once=build(source.length),restored=JSON.parse(JSON.stringify(each.object));
          const saved=JSON.stringify(each.object.points),before=InkEngine.ropeState(each.object);
          const oldCenters=each.centers,locked=before.anchors[Math.max(0,before.lockedCount-1)];
          // The curve near the last locked peg still uses a mutable neighbor.
          // Compare the clearly committed region, leaving two peg spacings of support.
          const prefix=oldCenters.filter(point=>point[0]<locked.x-before.spacing*2);
          for(let i=1;i<=16;i++)each.object.points.push(roundSample(132.4+i*0.8,source.at(-1).y+i*0.3,180+i));
          const after=InkEngine.ropeState(each.object),afterCenters=InkEngine.centerline(each.object);
          return {sameCenters:JSON.stringify(batch.centers)===JSON.stringify(once.centers)&&
              JSON.stringify(batch.centers)===JSON.stringify(oldCenters),
            sameState:JSON.stringify(batch.state)===JSON.stringify(once.state),
            samePixels:batch.pixels===once.pixels&&batch.pixels===each.pixels,
            reload:JSON.stringify(InkEngine.centerline(restored))===JSON.stringify(oldCenters)&&roundPixels(restored)===batch.pixels,
            savedPreserved:saved===JSON.stringify(each.object.points.slice(0,source.length)),
            prefixFixed:JSON.stringify(prefix)===JSON.stringify(afterCenters.slice(0,prefix.length)),
            anchorsFixed:JSON.stringify(before.anchors.slice(0,before.lockedCount))===
              JSON.stringify(after.anchors.slice(0,before.lockedCount)),
            boundedPressure:afterCenters.every(point=>point[2]>=0.4299999&&point[2]<=0.5700001)};
        }""")

        if os.environ.get("ST_WEB_ROUND_REPORT"):
            print(json.dumps({"corners": corners, "jitter": jitter, "loops": loops, "replay": replay}, indent=2))
        for corner in corners:
            current, old = corner["current"], corner["old"]
            assert current["finite"], corner
            assert current["sourceUnchanged"] and old["sourceUnchanged"], corner
            assert current["first"] == corner["expectedFirst"] and current["last"] == corner["expectedLast"], corner
            assert current["peak"] <= old["peak"] * 0.6, corner
            assert 1.5 <= current["apexDistance"] <= 4.5, corner
            assert current["nearApexWidth"] >= 2.2 and current["localRadius"] >= 1.5, corner
            assert 0.43 <= current["pressureMin"] <= current["pressureMax"] <= 0.57, corner
        print("PASS acute V and hook cusps have substantially rounder curvature at equal spatial sampling")

        assert jitter["current"]["rms"] <= jitter["old"]["rms"] * 0.85, jitter
        assert jitter["current"]["total"] < jitter["old"]["total"] * 0.85, jitter
        assert 16.2 <= jitter["current"]["height"] <= 19.8, jitter
        print("PASS tremor is reduced further while the intended handwritten letter height remains stable")

        for loop in loops:
            assert loop["finite"] and loop["centerAlpha"] == 0, loop
            assert loop["first"] == loop["expectedFirst"] and loop["last"] == loop["expectedLast"], loop
            assert loop["width"] >= loop["radius"] * 1.6 and loop["height"] >= loop["radius"] * 1.6, loop
            assert loop["area"] >= 0.7 * 3.141592653589793 * loop["radius"] ** 2, loop
        print("PASS 3–6 px letter loops retain their opening, dimensions, area and exact endpoints")

        assert all(replay.values()), replay
        print("PASS batch replay, reload, pressure bounds and committed curve/anchor invariance")

        forecasts = page.evaluate("""() => {
          const points=Array.from({length:65},(_,i)=>roundSample(35+i*1.1,190+4*Math.sin(i/14),i));
          const predicted=roundObject(points),control=roundObject(points);
          const state=JSON.stringify(InkEngine.ropeState(predicted)),centers=JSON.stringify(InkEngine.centerline(predicted));
          const last=points.at(-1),preview=InkEngine.previewStroke(predicted,{...last,x:last.x+2,y:last.y+0.5,t:last.t+8});
          InkEngine.centerline(preview);roundPixels(preview);
          const untouched=state===JSON.stringify(InkEngine.ropeState(predicted))&&centers===JSON.stringify(InkEngine.centerline(predicted));
          for(let i=1;i<=20;i++){
            const next=roundSample(last.x-i*0.4,last.y+i*0.9,points.length+i);
            predicted.points.push({...next});control.points.push({...next});
            InkEngine.centerline(predicted);InkEngine.centerline(control);
          }
          return {untouched,sameCenters:JSON.stringify(InkEngine.centerline(predicted))===JSON.stringify(InkEngine.centerline(control)),
            sameState:JSON.stringify(InkEngine.ropeState(predicted))===JSON.stringify(InkEngine.ropeState(control)),
            samePixels:roundPixels(predicted)===roundPixels(control),savedRealOnly:predicted.points.length===85};
        }""")
        assert all(forecasts.values()), forecasts
        print("PASS prediction leaves confirmed round geometry unchanged across a following sharp reversal")

        retrace = page.evaluate("""() => {
          const points=[[20,80],[90,80],[20,80]].map((point,i)=>roundSample(...point,i));
          const object=roundObject(points),centers=InkEngine.centerline(object),before=JSON.stringify(centers),pixels=roundPixels(object);
          for(let i=0;i<24;i++)object.points.push(roundSample(20,80,3+i));
          const after=InkEngine.centerline(object);
          return {finite:centers.every(point=>point.every(Number.isFinite)),
            noSideBulge:centers.every(point=>Math.abs(point[1]-80)<1e-7&&point[0]>=20-1e-7&&point[0]<=90+1e-7),
            reachesReversal:Math.max(...centers.map(point=>point[0]))>=87,
            noDwellReshape:before===JSON.stringify(after)&&pixels===roundPixels(object),
            fixedEnds:JSON.stringify(centers[0].slice(0,2))===JSON.stringify([20,80])&&
              JSON.stringify(centers.at(-1).slice(0,2))===JSON.stringify([20,80])};
        }""")
        assert all(retrace.values()), retrace
        print("PASS a 180-degree retrace keeps its intended axis and repeated stationary samples leave geometry unchanged")

        acute_returns = page.evaluate("""() => [170,175].map(degrees=>{
          const angle=degrees/180*Math.PI,vertices=[[20,60],[120,60],[120+100*Math.cos(angle),60+100*Math.sin(angle)]];
          const points=vertices.map((point,i)=>roundSample(...point,i,0.86+0.14*i));
          const object=roundObject(points),saved=JSON.stringify(object.points),centers=InkEngine.centerline(object);
          const oldCenters=InkEngine.centerline(roundObject(points,true));
          const maxX=Math.max(...centers.map(point=>point[0])),oldMaxX=Math.max(...oldCenters.map(point=>point[0]));
          const segmentDistance=(point,a,b)=>{
            const dx=b[0]-a[0],dy=b[1]-a[1];
            const t=Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/(dx*dx+dy*dy)));
            return Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dy);
          };
          const build=chunk=>{
            const result=roundObject([]);
            for(let i=0;i<points.length;i+=chunk){result.points.push(...points.slice(i,i+chunk));InkEngine.centerline(result);}
            return result;
          };
          const each=build(1),batch=build(points.length),restored=JSON.parse(JSON.stringify(object));
          const lowX=Math.min(...vertices.map(point=>point[0])),highX=Math.max(...vertices.map(point=>point[0]));
          const lowY=Math.min(...vertices.map(point=>point[1])),highY=Math.max(...vertices.map(point=>point[1]));
          return {degrees,retreat:120-maxX,extraRetreat:oldMaxX-maxX,
            fixedEnds:JSON.stringify(centers[0].slice(0,2))===JSON.stringify(vertices[0])&&
              JSON.stringify(centers.at(-1).slice(0,2))===JSON.stringify(vertices.at(-1)),
            sourceUnchanged:saved===JSON.stringify(object.points),
            finite:centers.every(point=>point.every(Number.isFinite)),
            noSideBulge:centers.every(point=>point[0]>=lowX-0.8&&point[0]<=highX+0.8&&
              point[1]>=lowY-0.8&&point[1]<=highY+0.8),
            deviation:Math.max(...centers.map(point=>Math.min(segmentDistance(point,vertices[0],vertices[1]),
              segmentDistance(point,vertices[1],vertices[2])))),
            boundedPressure:centers.every(point=>point[2]>=0.4299999&&point[2]<=0.5700001),
            replay:JSON.stringify(InkEngine.centerline(each))===JSON.stringify(centers)&&
              JSON.stringify(InkEngine.centerline(batch))===JSON.stringify(centers)&&
              JSON.stringify(InkEngine.centerline(restored))===JSON.stringify(centers)&&
              roundPixels(each)===roundPixels(object)&&roundPixels(batch)===roundPixels(object)&&roundPixels(restored)===roundPixels(object)};
        })""")
        if os.environ.get("ST_WEB_ROUND_REPORT"):
            print(json.dumps({"acuteReturns": acute_returns}, indent=2))
        for acute_return in acute_returns:
            assert 2.5 <= acute_return["retreat"] <= 4.5, acute_return
            assert 2.5 <= acute_return["extraRetreat"] <= 4.5, acute_return
            assert all(acute_return[key] for key in ["fixedEnds", "sourceUnchanged", "finite", "noSideBulge", "boundedPressure", "replay"]), acute_return
            assert acute_return["deviation"] <= 0.8, acute_return
        print("PASS 170/175-degree returns use a bounded rounded head without adding a sideways stroke")

        stationary_lift = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          view={x:0,y:0,z:1,fit:false};chooseTool('pen');draw();canvas.setPointerCapture=()=>{};
          const event=(type,x,y,i)=>{
            const rect=canvas.getBoundingClientRect();
            const pointer=new PointerEvent(type,{bubbles:true,pointerId:27,pointerType:'pen',button:0,
              buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:0.6,tiltX:30,tiltY:15,
              clientX:rect.left+view.x+x*view.z,clientY:rect.top+view.y+y*view.z});
            Object.defineProperty(pointer,'timeStamp',{value:1000+i*8});canvas.dispatchEvent(pointer);
          };
          event('pointerdown',100,280,0);
          for(let i=1;i<=40;i++)event('pointermove',100+i,280+5*Math.sin(i/13),i);
          const points=JSON.stringify(active.points),centers=JSON.stringify(InkEngine.centerline(active));
          const pixels=roundPixels(active),savedOptions=JSON.stringify(active.inkOptions);
          event('pointerup',140,280+5*Math.sin(40/13),41);
          const saved=objects[0];
          return {version:saved.inkVersion,currentVersion:InkEngine.profile.version,
            pointsFixed:points===JSON.stringify(saved.points),centersFixed:centers===JSON.stringify(InkEngine.centerline(saved)),
            pixelsFixed:pixels===roundPixels(saved),optionsFixed:savedOptions===JSON.stringify(saved.inkOptions),
            metadata:saved.points.every(point=>Number.isFinite(point.pressure)&&point.tiltX===30&&point.tiltY===15&&Number.isFinite(point.t)),
            lastPressure:saved.points.at(-1).p,previousPressure:saved.points.at(-2).p};
        }""")
        assert stationary_lift["version"] == stationary_lift["currentVersion"], stationary_lift
        assert all(stationary_lift[key] for key in ["pointsFixed", "centersFixed", "pixelsFixed", "optionsFixed", "metadata"]), stationary_lift
        assert 0.86 <= stationary_lift["lastPressure"] <= 1.14, stationary_lift
        print("PASS live capture uses current round profile and stationary lift preserves samples, curve and pixels")

        preview_path = os.environ.get("ST_WEB_ROUND_PREVIEW")
        if preview_path:
            data_url = page.evaluate("""() => {
              const surface=document.createElement('canvas');surface.width=1320;surface.height=600;
              const context=surface.getContext('2d');context.scale(3,3);context.fillStyle='#fffdf5';context.fillRect(0,0,440,200);
              context.font='13px sans-serif';context.fillStyle='#24304a';context.fillText('Previous rope (v6)',15,22);
              context.fillText('Rounded rope',235,22);
              const fixtures=[[[20,80],[50,20],[80,80]],[[20,120],[55,60],[62,120],[90,132]]];
              for(const [index,legacy] of [true,false].entries()){
                context.save();context.translate(index*220,35);
                fixtures.forEach(vertices=>paintObject(context,roundObject(vertices.map((point,i)=>roundSample(...point,i)),legacy)));
                const circle=Array.from({length:121},(_,i)=>roundSample(150+6*Math.cos(i/120*2*Math.PI),100+6*Math.sin(i/120*2*Math.PI),i));
                paintObject(context,roundObject(circle,legacy));context.restore();
              }
              return surface.toDataURL();
            }""")
            import base64
            Path(preview_path).write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
            print(f"Preview: {preview_path}")

        browser.close()
        assert not errors, errors
        print("Round ink checks passed.")


if __name__ == "__main__":
    run()
