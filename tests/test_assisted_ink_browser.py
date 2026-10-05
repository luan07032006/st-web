"""Run: python tests/test_assisted_ink_browser.py (Python Playwright + Chrome).
Handwriting assistance acceptance checks with 8-12 Hz tremor and sensor noise.
Version 8 input/geometry remains a frozen comparison; HTTP and saves are mocked.
"""
import base64
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

SETUP = """() => {
  window.assistedOldOptions={smoothing:.65,streamline:0,thinning:1,simulatePressure:false,
    rounding:1.2,ropeSpacing:.75,ropeLimit:2,ropeWindow:32,ropeBending:8,
    ropeCornerRadius:2.2,ropeCornerDrift:4,ropeCornerSupport:6};
  window.assistedRandom=seed=>()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
  window.assistedSample=(x,y,i=0,extra={})=>({x,y,t:1000+i*1000/120,pressure:.55,tiltX:30,tiltY:15,...extra});
  window.assistedHumps=()=>{
    const random=assistedRandom(173829);
    return Array.from({length:401},(_,i)=>{
      const x=40+i*.7,time=i/120,slope=.9*Math.cos((x-40)/10),norm=Math.sqrt(1+slope*slope);
      const tremor=1.5*Math.sin(2*Math.PI*10*time)+.55*Math.sin(2*Math.PI*8*time)+.4*Math.sin(2*Math.PI*12*time);
      return assistedSample(x-slope/norm*tremor+(random()-.5)*.3,
        180+9*Math.sin((x-40)/10)+tremor/norm+(random()-.5)*.3,i,
        {pressure:.4+.25*i/400,tiltX:20+i%25});
    });
  };
  window.assistedStem=()=>{
    const random=assistedRandom(173830);
    return Array.from({length:241},(_,i)=>{
      const time=i/120,tremor=1.3*Math.sin(2*Math.PI*8*time)+.6*Math.sin(2*Math.PI*12*time);
      return assistedSample(100+tremor+(random()-.5)*.3,80+i*.45+(random()-.5)*.3,i);
    });
  };
  window.assistedCircle=radius=>{
    const random=assistedRandom(1000+radius*10);
    return Array.from({length:161},(_,i)=>{
      const angle=i/160*2*Math.PI,time=i/120;
      const noise=.2*Math.sin(2*Math.PI*8*time)+.1*Math.sin(2*Math.PI*12*time)+(random()-.5)*.05;
      return assistedSample(140+(radius+noise)*Math.cos(angle),120+(radius+noise)*Math.sin(angle),i,
        {pressure:.3+.35*i/160,tiltX:15+i%30});
    });
  };
  window.assistedStyle=legacy=>({type:'pen',color:'#24304a',width:legacy?1.6:InkEngine.profile.penSize,
    inkVersion:legacy?8:InkEngine.profile.version,
    inkOptions:legacy?{...assistedOldOptions}:InkEngine.strokeOptions({scale:1},'pen','pen')});
  window.assistedInput=(legacy=false,scale=1)=>InkEngine.createInput({pointerType:'pen',type:'pen',scale,
    positionMode:legacy?'adaptive':'assisted'});
  window.assistedBuild=(raw,legacy=false)=>{
    const input=assistedInput(legacy),points=raw.map((point,i)=>({...input.sample({...point,time:point.t},Boolean(point.endpoint)),rawIndex:i}));
    return {...assistedStyle(legacy),rawPoints:raw.map(point=>({...point})),points};
  };
  window.assistedResample=(points,step=.5)=>{
    if(!points.length)return [];
    const result=[points[0].slice(0,2)];let carry=0;
    for(let i=1;i<points.length;i++){
      let a=points[i-1].slice(0,2),b=points[i].slice(0,2),length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      while(length+carry>=step&&length>1e-9){const t=(step-carry)/length;
        a=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];result.push(a);
        length=Math.hypot(b[0]-a[0],b[1]-a[1]);carry=0;}
      carry+=length;
    }
    return result;
  };
  window.assistedTurning=points=>{
    let total=0,peak=0;
    for(let i=1;i<points.length-1;i++){
      const a=points[i-1],b=points[i],c=points[i+1],ux=b[0]-a[0],uy=b[1]-a[1],vx=c[0]-b[0],vy=c[1]-b[1];
      const denominator=Math.hypot(ux,uy)*Math.hypot(vx,vy);
      if(denominator>1e-8){const turn=Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/denominator)));total+=turn;peak=Math.max(peak,turn);}
    }
    return {total,peak};
  };
  window.assistedPixels=object=>{
    const surface=document.createElement('canvas');surface.width=760;surface.height=600;
    const context=surface.getContext('2d');context.scale(2,2);paintObject(context,object);return surface.toDataURL();
  };
}
"""


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
        page.evaluate(SETUP)

        tremor = page.evaluate("""() => {
          const analyze=(raw,legacy,kind)=>{
            const object=assistedBuild(raw,legacy),source=JSON.stringify(object.rawPoints);
            const path=assistedResample(InkEngine.centerline(object)).filter(point=>kind==='humps'
              ?point[0]>55&&point[0]<305:point[1]>92&&point[1]<175);
            const errors=path.map(point=>kind==='humps'
              ?(point[1]-180-9*Math.sin((point[0]-40)/10))/Math.sqrt(1+.81*Math.cos((point[0]-40)/10)**2)
              :point[0]-100);
            return {...assistedTurning(path),rms:Math.sqrt(errors.reduce((sum,value)=>sum+value*value,0)/errors.length),
              height:Math.max(...path.map(point=>point[1]))-Math.min(...path.map(point=>point[1])),
              sourceUnchanged:source===JSON.stringify(object.rawPoints),
              firstFixed:object.points[0].x===raw[0].x&&object.points[0].y===raw[0].y,
              metadata:object.points.every((point,i)=>point.rawIndex===i&&point.t===raw[i].t&&point.tiltX===raw[i].tiltX&&point.tiltY===raw[i].tiltY),
              finite:path.every(point=>point.every(Number.isFinite))};
          };
          return ['humps','stem'].map(kind=>{
            const raw=kind==='humps'?assistedHumps():assistedStem();
            return {kind,old:analyze(raw,true,kind),current:analyze(raw,false,kind)};
          });
        }""")
        if os.environ.get("ST_WEB_ASSISTED_REPORT"):
            print(json.dumps({"version": page.evaluate("InkEngine.profile.version"), "tremor": tremor}, indent=2))
        assert page.evaluate("InkEngine.profile.version") == 9
        for fixture in tremor:
            old, current = fixture["old"], fixture["current"]
            assert all(current[key] for key in ["sourceUnchanged", "firstFixed", "metadata", "finite"]), fixture
            assert current["rms"] <= old["rms"] * 0.6, fixture
            assert current["total"] <= old["total"] * 0.6 and current["peak"] <= old["peak"] * 0.75, fixture
            if fixture["kind"] == "humps":
                assert 16.2 <= current["height"] <= 20, fixture
        print("PASS 8-12Hz hand tremor and sensor noise are substantially reduced against frozen v8 while letter humps remain tall")

        response = page.evaluate("""() => [0,Math.PI/4,Math.PI/2].map(angle=>{
          const input=assistedInput(),scaled=assistedInput(false,.5),a=[],b=[],raw=[];
          const tx=Math.cos(angle),ty=Math.sin(angle),nx=-ty,ny=tx;
          for(let i=0;i<50;i++){
            const point=assistedSample(40+tx*i*8,80+ty*i*8,i);
            raw.push(point);a.push(input.sample({...point,time:point.t}));b.push(scaled.sample({...point,x:point.x*2,y:point.y*2,time:point.t}));
          }
          const metrics=a.map((point,i)=>{const dx=raw[i].x-point.x,dy=raw[i].y-point.y;
            return {tangent:Math.abs(dx*tx+dy*ty),normal:Math.abs(dx*nx+dy*ny),total:Math.hypot(dx,dy)};});
          const last=a.at(-1),stationary=input.sample({...raw.at(-1),time:raw.at(-1).t+8,pressure:.95,tiltX:60});
          return {angle,tangent:Math.max(...metrics.map(value=>value.tangent)),normal:Math.max(...metrics.map(value=>value.normal)),
            total:Math.max(...metrics.map(value=>value.total)),
            scaleMatches:a.every((point,i)=>Math.abs(point.x-b[i].x*.5)<1e-7&&Math.abs(point.y-b[i].y*.5)<1e-7),
            stationaryFixed:last.x===stationary.x&&last.y===stationary.y,
            stationaryPressureResponds:stationary.pressure>last.pressure&&stationary.tiltX===60,
            widthBounded:a.concat([stationary]).every(point=>point.p>=.86&&point.p<=1.14)};
        })""")
        for item in response:
            assert item["tangent"] < 1.2 and item["normal"] < 0.001 and item["total"] <= 2.4, item
            assert all(item[key] for key in ["scaleMatches", "stationaryFixed", "stationaryPressureResponds", "widthBounded"]), item
        noisy_response = page.evaluate("""() => {
          const raw=assistedHumps(),object=assistedBuild(raw);
          return Math.max(...object.points.map((point,i)=>Math.hypot(point.x-raw[i].x,point.y-raw[i].y)));
        }""")
        assert noisy_response <= 2.400001, noisy_response
        print("PASS rapid motion responds along the pen direction, transverse correction stays bounded and a paused nib stays fixed")

        loops = page.evaluate("""() => [3,4.5,6].map(radius=>{
          const raw=assistedCircle(radius),object=assistedBuild(raw),centers=InkEngine.centerline(object);
          let area=0;for(let i=1;i<centers.length;i++)area+=centers[i-1][0]*centers[i][1]-centers[i][0]*centers[i-1][1];
          area+=centers.at(-1)[0]*centers[0][1]-centers[0][0]*centers.at(-1)[1];
          const surface=document.createElement('canvas');surface.width=300;surface.height=250;
          const context=surface.getContext('2d');paintObject(context,object);
          return {radius,width:Math.max(...centers.map(point=>point[0]))-Math.min(...centers.map(point=>point[0])),
            height:Math.max(...centers.map(point=>point[1]))-Math.min(...centers.map(point=>point[1])),area:Math.abs(area/2),
            opening:context.getImageData(140,120,1,1).data[3]===0,
            firstFixed:centers[0][0]===raw[0].x&&centers[0][1]===raw[0].y,
            finite:centers.every(point=>point.every(Number.isFinite))};
        })""")
        for loop in loops:
            assert loop["width"] >= loop["radius"] * 1.6 and loop["height"] >= loop["radius"] * 1.6, loop
            assert loop["area"] >= 0.7 * 3.141592653589793 * loop["radius"] ** 2, loop
            assert loop["opening"] and loop["firstFixed"] and loop["finite"], loop
        print("PASS assisted 3-6px handwriting loops retain their opening, dimensions and enclosed area")

        accents = page.evaluate("""() => [2,5].map(length=>{
          const raw=Array.from({length:17},(_,i)=>assistedSample(110+length*i/16/Math.sqrt(2),220-length*i/16/Math.sqrt(2),i));
          const measure=legacy=>{
            const object=assistedBuild(raw,legacy),centers=InkEngine.centerline(object),first=centers[0],last=centers.at(-1);
            return {length:Math.hypot(last[0]-first[0],last[1]-first[1]),
              deviation:Math.max(...centers.map(point=>Math.abs(point[0]+point[1]-330)/Math.sqrt(2))),
              finite:centers.every(point=>point.every(Number.isFinite))};
          };
          return {length,old:measure(true),current:measure(false)};
        })""")
        for accent in accents:
            assert accent["current"]["finite"] and accent["current"]["deviation"] < 0.001, accent
            assert accent["current"]["length"] >= accent["length"] * 0.7, accent
            assert accent["current"]["length"] >= accent["old"]["length"] * 0.95, accent
        print("PASS short Vietnamese accent strokes remain visible and preserve their intended direction")

        replay = page.evaluate("""() => {
          const raw=assistedHumps(),build=chunk=>{
            const input=assistedInput(),object={...assistedStyle(false),rawPoints:[],points:[]};
            for(let i=0;i<raw.length;i++){
              object.rawPoints.push({...raw[i]});object.points.push({...input.sample({...raw[i],time:raw[i].t}),rawIndex:i});
              if((i+1)%chunk===0)InkEngine.centerline(object);
            }
            return {object,centers:InkEngine.centerline(object),state:InkEngine.ropeState(object),pixels:assistedPixels(object)};
          };
          const each=build(1),batch=build(13),once=build(raw.length),restored=JSON.parse(JSON.stringify(each.object));
          const prefix=JSON.stringify(each.centers.slice(0,100)),locked=each.state.lockedCount;
          const anchors=JSON.stringify(each.state.anchors.slice(0,locked));
          for(let i=1;i<=30;i++)each.object.points.push({...each.object.points.at(-1),x:320+i*.8,y:180+9*Math.sin((280+i*.8)/10)});
          const after=InkEngine.centerline(each.object),stateAfter=InkEngine.ropeState(each.object);
          return {batchCenters:JSON.stringify(batch.centers)===JSON.stringify(once.centers),
            eachCenters:JSON.stringify(each.centers)===JSON.stringify(once.centers),
            states:JSON.stringify(batch.state)===JSON.stringify(once.state)&&JSON.stringify(batch.state)===JSON.stringify(each.state),
            pixels:batch.pixels===once.pixels&&batch.pixels===each.pixels,
            reload:JSON.stringify(InkEngine.centerline(restored))===JSON.stringify(once.centers)&&assistedPixels(restored)===once.pixels,
            prefixFixed:prefix===JSON.stringify(after.slice(0,100)),
            anchorsFixed:anchors===JSON.stringify(stateAfter.anchors.slice(0,locked))};
        }""")
        assert all(replay.values()), replay
        print("PASS live, batched and saved assisted strokes agree while committed anchors and curve prefixes remain fixed")

        forecasts = page.evaluate("""() => {
          const make=()=>{
            const input=assistedInput(),raw=Array.from({length:25},(_,i)=>assistedSample(70+i*3,180,i));
            const object={...assistedStyle(false),rawPoints:raw.map(point=>({...point})),
              points:raw.map((point,i)=>({...input.sample({...point,time:point.t}),rawIndex:i}))};
            return {input,object};
          };
          const a=make(),b=make(),points=JSON.stringify(a.object),state=JSON.stringify(InkEngine.ropeState(a.object));
          const prediction=a.input.predict(),last=a.object.points.at(-1),preview=InkEngine.previewStroke(a.object,prediction);
          InkEngine.centerline(preview);assistedPixels(preview);
          const untouched=points===JSON.stringify(a.object)&&state===JSON.stringify(InkEngine.ropeState(a.object));
          const next=assistedSample(140,186,25),first=a.input.sample({...next,time:next.t}),second=b.input.sample({...next,time:next.t});
          a.object.rawPoints.push({...next});b.object.rawPoints.push({...next});
          a.object.points.push({...first,rawIndex:25});b.object.points.push({...second,rawIndex:25});
          return {prediction:prediction&&Math.hypot(prediction.x-last.x,prediction.y-last.y)>0&&
              Math.hypot(prediction.x-last.x,prediction.y-last.y)<=2.000001,
            metadata:prediction&&['p','pressure','tiltX','tiltY'].every(key=>prediction[key]===last[key]),untouched,
            inputState:JSON.stringify(first)===JSON.stringify(second),
            centers:JSON.stringify(InkEngine.centerline(a.object))===JSON.stringify(InkEngine.centerline(b.object)),
            pixels:assistedPixels(a.object)===assistedPixels(b.object),
            realOnly:a.object.rawPoints.length===26&&a.object.points.length===26};
        }""")
        assert all(forecasts.values()), forecasts
        print("PASS preview uses bounded forecasts without altering input history, confirmed geometry or saved samples")

        capture = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          view={x:0,y:0,z:1,fit:false};chooseTool('pen');draw();canvas.setPointerCapture=()=>{};
          const raw=assistedHumps().slice(0,100).map(point=>({...point,y:point.y+60}));
          const event=(type,point)=>{
            const rect=canvas.getBoundingClientRect(),pointer=new PointerEvent(type,{bubbles:true,pointerId:27,pointerType:'pen',button:0,
              buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:point.pressure,tiltX:point.tiltX,tiltY:point.tiltY,
              clientX:rect.left+view.x+point.x*view.z,clientY:rect.top+view.y+point.y*view.z});
            Object.defineProperty(pointer,'timeStamp',{value:point.t});canvas.dispatchEvent(pointer);
          };
          event('pointerdown',raw[0]);for(let i=1;i<raw.length;i++)event('pointermove',raw[i]);
          const before=JSON.stringify(active.points),curve=JSON.stringify(InkEngine.centerline(active));
          event('pointerup',{...raw.at(-1),t:raw.at(-1).t+8});const saved=JSON.parse(JSON.stringify(objects[0]));
          const rebuilt=assistedBuild(saved.rawPoints.slice(0,-1));
          // The app can drop subpixel display points, so link by captured raw index.
          const modelMatches=saved.points.every(point=>{
            const sample=rebuilt.points[point.rawIndex];return sample&&Math.abs(point.x-sample.x)<1e-7&&Math.abs(point.y-sample.y)<1e-7;
          });
          const stationary=before===JSON.stringify(saved.points)&&curve===JSON.stringify(InkEngine.centerline(saved));
          const last=saved.rawPoints.at(-1),rawMetadata=saved.rawPoints.every(point=>[point.x,point.y,point.pressure,point.tiltX,point.tiltY,point.t].every(Number.isFinite));
          return {saved,modelMatches,stationary,rawMetadata,profile:saved.inkVersion===9,
            liftRecorded:last.endpoint===true&&last.pressure===0,
            finite:InkEngine.centerline(saved).every(point=>point.every(Number.isFinite))};
        }""")
        assert all(capture[key] for key in ["modelMatches", "stationary", "rawMetadata", "profile", "liftRecorded", "finite"]), capture
        page.evaluate("saveLesson()")
        assert saves[-1]["objects"] == [capture["saved"]], saves[-1]
        print("PASS browser stylus capture runs the assisted model and records actual pressure/time without a lift hook")

        if os.environ.get("ST_WEB_ASSISTED_REPORT"):
            print(json.dumps({"response": response, "maxNoisyLag": noisy_response, "loops": loops, "accents": accents}, indent=2))
        preview_path = os.environ.get("ST_WEB_ASSISTED_PREVIEW")
        if preview_path:
            data = page.evaluate("""() => {
              const surface=document.createElement('canvas');surface.width=2160;surface.height=840;
              const context=surface.getContext('2d');context.scale(3,3);context.fillStyle='#fffdf5';context.fillRect(0,0,720,280);
              context.font='14px sans-serif';context.fillStyle='#24304a';
              for(const [column,legacy] of [true,false].entries()){
                context.save();context.translate(column*360,0);context.fillText(legacy?'V8':'Assisted handwriting',20,30);
                context.save();context.translate(0,-95);paintObject(context,assistedBuild(assistedHumps(),legacy));context.restore();
                for(const [i,radius] of [3,4.5,6].entries()){
                  const object=assistedBuild(assistedCircle(radius),legacy);context.save();context.translate(-60+i*70,70);paintObject(context,object);context.restore();
                }
                context.restore();
              }
              return surface.toDataURL();
            }""")
            Path(preview_path).write_bytes(base64.b64decode(data.split(",", 1)[1]))
            print(f"Preview: {preview_path}")
        assert not errors, errors
        browser.close()
        print("Assisted handwriting checks passed.")


if __name__ == "__main__":
    run()
