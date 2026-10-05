"""Run: python tests/test_input_pipeline_browser.py (Python Playwright + Chrome).
Acceptance checks for raw capture -> adaptive input -> vector ink -> temporary prediction.
All HTTP and lesson saves are mocked; no actual lesson data is modified.
"""
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

SETUP = """() => {
  window.pipelineSample=(x,y,i=0,extra={})=>({x,y,pressure:0.5,tiltX:20,tiltY:10,t:1000+i*8,...extra});
  window.pipelineBuild=(rawPoints,options={})=>{
    const input=InkEngine.createInput({pointerType:'pen',type:'pen',scale:1,positionMode:'adaptive',...options});
    const points=rawPoints.map((point,i)=>({...input.sample({...point,time:point.t},Boolean(point.endpoint)),rawIndex:i}));
    return {type:'pen',color:'#24304a',width:1.6,inkVersion:InkEngine.profile.version,
      inkOptions:InkEngine.strokeOptions({scale:1},'pen','pen'),rawPoints:rawPoints.map(point=>({...point})),points};
  };
  window.pipelinePixels=object=>{
    const surface=document.createElement('canvas');surface.width=720;surface.height=1120;
    const context=surface.getContext('2d');context.scale(2,2);paintObject(context,object);return surface.toDataURL();
  };
  window.pipelineEvent=(type,x,y,options={})=>{
    const rect=canvas.getBoundingClientRect(),{time=1000,...pointerOptions}=options;
    const event=new PointerEvent(type,{bubbles:true,pointerId:27,pointerType:'pen',button:0,
      buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:0.6,tiltX:30,tiltY:15,
      clientX:rect.left+view.x+x*view.z,clientY:rect.top+view.y+y*view.z,...pointerOptions});
    Object.defineProperty(event,'timeStamp',{value:time});canvas.dispatchEvent(event);
    return {x,y,pressure:event.pressure,tiltX:event.tiltX,tiltY:event.tiltY,t:event.timeStamp};
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

        def prepare(target):
            target.add_init_script("sessionStorage.setItem('qh-authenticated', 'true')")
            target.route("**/*", serve)
            target.goto("http://localhost/index.html")
            target.wait_for_function("typeof boardW !== 'undefined' && boardW > 0")
            target.evaluate(SETUP)

        prepare(page)
        assert page.evaluate("InkEngine.profile.version") == 8

        adaptive = page.evaluate("""() => {
          const create=scale=>InkEngine.createInput({pointerType:'pen',type:'pen',scale,positionMode:'adaptive'});
          const raw=Array.from({length:161},(_,i)=>pipelineSample(100+i*0.35,180+(i%2?1.2:-1.2),i));
          const object=pipelineBuild(raw),first=object.points[0];
          const rms=points=>Math.sqrt(points.slice(20).reduce((sum,point)=>sum+Math.pow(point.y-180,2),0)/(points.length-20));
          const jitter=points=>points.slice(21).reduce((sum,point,i)=>sum+Math.abs(point.y-points[i+20].y),0)/(points.length-21);
          const fast=create(1),slow=create(1),scaled=create(0.5),fastPoints=[],scaledPoints=[];
          for(let i=0;i<45;i++){
            const point={x:20+i*8,y:80,time:2000+i*8,pressure:0.6,tiltX:35,tiltY:10};
            fastPoints.push(fast.sample(point));scaledPoints.push(scaled.sample({...point,x:point.x*2,y:point.y*2}));
          }
          const before=fastPoints.at(-1),lift=fast.sample({x:20+45*8,y:80,time:2360,pressure:0,tiltX:35,tiltY:10},true);
          const low=slow.sample({x:10,y:30,time:3000,pressure:0.1});
          const high=create(1).sample({x:10,y:30,time:3000,pressure:0.9,tiltX:60});
          return {rawRms:rms(raw),filteredRms:rms(object.points),rawJitter:jitter(raw),filteredJitter:jitter(object.points),
            firstFixed:first.x===raw[0].x&&first.y===raw[0].y,
            sourceUnchanged:JSON.stringify(object.rawPoints)===JSON.stringify(raw),
            maxInputLag:Math.max(...object.points.map((point,i)=>Math.hypot(point.x-raw[i].x,point.y-raw[i].y))),
            fastLag:Math.max(...fastPoints.map((point,i)=>Math.hypot(20+i*8-point.x,80-point.y))),
            fastMoves:fastPoints.slice(1).every((point,i)=>point.x>fastPoints[i].x),
            scaleMatches:fastPoints.every((point,i)=>Math.abs(point.x-scaledPoints[i].x*0.5)<1e-7&&Math.abs(point.y-scaledPoints[i].y*0.5)<1e-7),
            liftFiltered:lift.x<380-1e-7&&Math.hypot(380-lift.x,80-lift.y)<1,
            liftPressureHeld:lift.p===before.p&&lift.pressure===before.pressure,
            pressureLow:low.p,pressureHigh:high.p,
            widthsBounded:object.points.concat(fastPoints).every(point=>point.p>=0.86&&point.p<=1.14),
            allFinite:object.points.concat(fastPoints,[lift]).every(point=>[point.x,point.y,point.p,point.pressure,point.t].every(Number.isFinite))};
        }""")
        assert adaptive["filteredRms"] < adaptive["rawRms"] * 0.65, adaptive
        assert adaptive["filteredJitter"] < adaptive["rawJitter"] * 0.65, adaptive
        assert adaptive["maxInputLag"] <= 0.900001 and adaptive["fastLag"] < 1, adaptive
        assert all(adaptive[key] for key in ["firstFixed", "sourceUnchanged", "fastMoves", "scaleMatches", "liftFiltered", "liftPressureHeld", "widthsBounded", "allFinite"]), adaptive
        assert 0.86 <= adaptive["pressureLow"] < adaptive["pressureHigh"] <= 1.14, adaptive
        print("PASS adaptive input reduces jitter, bounds fast lag, preserves the first point and filters genuine lift movement")

        loops = page.evaluate("""() => [3,6].map(radius=>{
          const raw=Array.from({length:161},(_,i)=>pipelineSample(130+radius*Math.cos(i/160*2*Math.PI),
            120+radius*Math.sin(i/160*2*Math.PI),i,{pressure:0.3+0.4*i/160,tiltX:i%50,tiltY:15}));
          const original=JSON.stringify(raw),object=pipelineBuild(raw),centers=InkEngine.centerline(object);
          const xs=centers.map(point=>point[0]),ys=centers.map(point=>point[1]);
          let area=0;for(let i=1;i<centers.length;i++)area+=centers[i-1][0]*centers[i][1]-centers[i][0]*centers[i-1][1];
          area+=centers.at(-1)[0]*centers[0][1]-centers[0][0]*centers.at(-1)[1];
          const surface=document.createElement('canvas');surface.width=300;surface.height=250;
          const context=surface.getContext('2d');paintObject(context,object);
          return {radius,width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),area:Math.abs(area/2),
            firstFixed:centers[0][0]===raw[0].x&&centers[0][1]===raw[0].y,
            lastLag:Math.hypot(object.points.at(-1).x-raw.at(-1).x,object.points.at(-1).y-raw.at(-1).y),
            sourceUnchanged:original===JSON.stringify(raw)&&original===JSON.stringify(object.rawPoints),
            links:object.points.every((point,i)=>point.rawIndex===i&&point.t===raw[i].t&&point.tiltX===raw[i].tiltX&&point.tiltY===raw[i].tiltY),
            opening:context.getImageData(130,120,1,1).data[3]===0,
            finite:centers.every(point=>point.every(Number.isFinite))};
        })""")
        for loop in loops:
            assert all(loop[key] for key in ["firstFixed", "sourceUnchanged", "links", "opening", "finite"]), loop
            assert loop["lastLag"] < 1, loop
            assert loop["width"] >= loop["radius"] * 1.6 and loop["height"] >= loop["radius"] * 1.6, loop
            assert loop["area"] >= 0.7 * 3.141592653589793 * loop["radius"] ** 2, loop
        print("PASS adaptive raw-to-curve pipeline preserves small loop openings, size and stylus metadata")

        prediction = page.evaluate("""() => ['pen','mouse','touch'].map(pointerType=>{
          const build=()=>{
            const input=InkEngine.createInput({pointerType,type:'pen',scale:1,positionMode:'adaptive'}),points=[];
            for(let i=0;i<9;i++)points.push(input.sample({x:100+i*3,y:180,time:3000+i*8,pressure:0.6,tiltX:25,tiltY:10}));
            return {input,points,last:points.at(-1)};
          };
          const actual=build(),control=build(),saved=JSON.stringify(actual.points);
          const fallback=actual.input.predict(),native=actual.input.predict([{x:125,y:180.4,time:3072,pressure:1,tiltX:85}]);
          const next={x:127,y:180,time:3072,pressure:0.7,tiltX:30,tiltY:15};
          const noStateMutation=JSON.stringify(actual.input.sample(next))===JSON.stringify(control.input.sample(next));
          const stopped=build();stopped.input.sample({x:124,y:180,time:3072,pressure:0.6});
          const reversed=build();reversed.input.sample({x:120,y:180,time:3072,pressure:0.6});
          const gap=build();gap.input.sample({x:127,y:180,time:3150,pressure:0.6});
          return {pointerType,last:actual.last,fallback,native,noStateMutation,noArrayMutation:saved===JSON.stringify(actual.points),
            stopped:stopped.input.predict(),reversed:reversed.input.predict(),gap:gap.input.predict()};
        })""")
        for result in prediction:
            last = result["last"]
            assert result["noStateMutation"] and result["noArrayMutation"], result
            for name in ["fallback", "native"]:
                point = result[name]
                assert point and point["x"] > last["x"], result
                assert ((point["x"] - last["x"]) ** 2 + (point["y"] - last["y"]) ** 2) ** 0.5 <= 2.000001, result
                assert all(point[key] == last[key] for key in ["p", "pressure", "tiltX", "tiltY"]), result
            assert 0 < result["native"]["y"] - last["y"] < 0.4 and result["native"]["x"] < 125 - 1e-7, result
            assert all(result[key] is None for key in ["stopped", "reversed", "gap"]), result
        print("PASS filtered pen/mouse/touch forecasts remain bounded, nonmutating and temporary")

        captured = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          view={x:0,y:0,z:1,fit:false};chooseTool('pen');draw();canvas.setPointerCapture=()=>{};
          const expected=[pipelineEvent('pointerdown',100,220,{time:4000,pressure:0.55,tiltX:20,tiltY:5})];
          const batchSamples=[{x:102,y:221,t:4008,pressure:0.4,tiltX:25,tiltY:10},
            {x:104,y:219,t:4016,pressure:0.5,tiltX:30,tiltY:15},
            {x:106,y:222,t:4024,pressure:0.65,tiltX:35,tiltY:20},
            {x:109,y:223,t:4032,pressure:0.7,tiltX:40,tiltY:25}];
          const rect=canvas.getBoundingClientRect();
          const events=batchSamples.map(point=>({pointerId:27,pointerType:'pen',pressure:point.pressure,tiltX:point.tiltX,tiltY:point.tiltY,
            clientX:rect.left+view.x+point.x*view.z,clientY:rect.top+view.y+point.y*view.z,timeStamp:point.t}));
          const batch=new PointerEvent('pointermove',{bubbles:true,pointerId:27,pointerType:'pen'});
          Object.defineProperty(batch,'getCoalescedEvents',{value:()=>events});canvas.dispatchEvent(batch);expected.push(...batchSamples);
          expected.push(pipelineEvent('pointermove',112,222,{time:4040,pressure:0.6,tiltX:45,tiltY:30}));
          const before={points:JSON.stringify(active.points),curve:JSON.stringify(InkEngine.centerline(active)),pixels:pipelinePixels(active),raw:active.rawPoints.length};
          expected.push(pipelineEvent('pointerup',112,222,{time:4048,pressure:0,tiltX:45,tiltY:30}));
          const saved=JSON.parse(JSON.stringify(objects[0]));
          const rawMatches=saved.rawPoints.length===expected.length&&saved.rawPoints.every((point,i)=>
            ['x','y','pressure','tiltX','tiltY','t'].every(key=>point[key]===expected[i][key]));
          const filteredDiffers=saved.points.some(point=>Math.hypot(point.x-saved.rawPoints[point.rawIndex].x,point.y-saved.rawPoints[point.rawIndex].y)>0.01);
          pipelineEvent('pointerdown',220,260,{time:4100});pipelineEvent('pointermove',230,265,{time:4108});
          const previous=JSON.parse(JSON.stringify(active.points.at(-1)));
          pipelineEvent('pointerup',236,268,{time:4116,pressure:0});
          const moving=JSON.parse(JSON.stringify(objects[1])),last=moving.points.at(-1),rawLast=moving.rawPoints.at(-1);
          const dwellExpected=[pipelineEvent('pointerdown',320,320,{time:4200})];
          for(let i=1;i<=8;i++)dwellExpected.push(pipelineEvent('pointermove',320,320,{time:4200+i*8}));
          dwellExpected.push(pipelineEvent('pointerup',320,320,{time:4272,pressure:0}));
          const dwell=JSON.parse(JSON.stringify(objects[2]));
          return {saved,moving,dwell,rawMatches,filteredDiffers,
            fixedFirst:saved.points[0].x===expected[0].x&&saved.points[0].y===expected[0].y,
            links:saved.points.every(point=>Number.isInteger(point.rawIndex)&&point.rawIndex>=0&&point.rawIndex<saved.rawPoints.length&&point.t===saved.rawPoints[point.rawIndex].t),
            stationaryRawRecorded:saved.rawPoints.length===before.raw+1&&saved.rawPoints.at(-1).endpoint===true&&saved.rawPoints.at(-1).pressure===0,
            stationaryPointsFixed:before.points===JSON.stringify(saved.points)&&before.curve===JSON.stringify(InkEngine.centerline(saved))&&before.pixels===pipelinePixels(saved),
            movingLag:Math.hypot(last.x-rawLast.x,last.y-rawLast.y),movingFiltered:last.x!==rawLast.x||last.y!==rawLast.y,
            movingPressureHeld:last.p===previous.p&&last.pressure===previous.pressure,
            movingRawFinal:rawLast.x===236&&rawLast.y===268&&rawLast.t===4116&&rawLast.pressure===0&&rawLast.endpoint===true,
            stationarySamplesRetained:dwell.points.length===1&&dwell.rawPoints.length===dwellExpected.length&&
              dwell.rawPoints.every((point,i)=>['x','y','pressure','tiltX','tiltY','t'].every(key=>point[key]===dwellExpected[i][key]))};
        }""")
        assert all(captured[key] for key in ["rawMatches", "filteredDiffers", "fixedFirst", "links", "stationaryRawRecorded", "stationaryPointsFixed", "movingFiltered", "movingPressureHeld", "movingRawFinal", "stationarySamplesRetained"]), captured
        assert captured["movingLag"] < 1, captured
        assert captured["saved"]["inkVersion"] == 8 and captured["moving"]["inkVersion"] == 8
        page.evaluate("saveLesson()")
        assert saves[-1]["objects"] == [captured["saved"], captured["moving"], captured["dwell"]], saves[-1]
        page.evaluate("undo();redo()")
        assert page.evaluate("JSON.parse(JSON.stringify(objects))") == [captured["saved"], captured["moving"], captured["dwell"]]
        reload = page.evaluate("""() => {
          const before=objects.map(object=>pipelinePixels(object)),saved=JSON.stringify(objects),doc=lessonData();
          applyDoc(validateDoc(JSON.parse(JSON.stringify(doc))));draw();
          return {vectorsFixed:saved===JSON.stringify(objects),pixelsFixed:objects.every((object,i)=>pipelinePixels(object)===before[i])};
        }""")
        assert all(reload.values()), reload
        print("PASS coalesced raw capture, filtered display, lift semantics, save, undo and JSON reload")

        transforms = page.evaluate("""() => {
          const object=pipelineBuild(Array.from({length:71},(_,i)=>pipelineSample(40+i*2,350+6*Math.sin(i/12),i,
            {pressure:0.2+i*0.008,tiltX:i%45,tiltY:15}))),before=JSON.parse(JSON.stringify(object));
          const curve=InkEngine.centerline(object);moveObject(object,30,-20);
          const moved=JSON.parse(JSON.stringify(object)),movedCurve=InkEngine.centerline(object),movedBox=bounds(object);
          scalePaperObject(object,0.5);const scaledCurve=InkEngine.centerline(object);
          const movedArrays=['points','rawPoints'].every(key=>object[key].length===before[key].length&&moved[key].every((point,i)=>
            point.x===before[key][i].x+30&&point.y===before[key][i].y-20));
          const scaledArrays=['points','rawPoints'].every(key=>object[key].every((point,i)=>
            Math.abs(point.x-(movedBox.x+(moved[key][i].x-movedBox.x)*0.5))<1e-7&&
            Math.abs(point.y-(movedBox.y+(moved[key][i].y-movedBox.y)*0.5))<1e-7));
          const metadata=['points','rawPoints'].every(key=>object[key].every((point,i)=>
            ['pressure','tiltX','tiltY','t','rawIndex','endpoint'].every(field=>point[field]===before[key][i][field])));
          return {movedArrays,scaledArrays,metadata,
            curveMoved:curve.length===movedCurve.length&&curve.every((point,i)=>Math.abs(movedCurve[i][0]-point[0]-30)<1e-7&&Math.abs(movedCurve[i][1]-point[1]+20)<1e-7),
            curveScaled:movedCurve.length===scaledCurve.length&&movedCurve.every((point,i)=>
              Math.abs(scaledCurve[i][0]-(movedBox.x+(point[0]-movedBox.x)*0.5))<1e-7&&
              Math.abs(scaledCurve[i][1]-(movedBox.y+(point[1]-movedBox.y)*0.5))<1e-7),
            reload:JSON.stringify(InkEngine.centerline(JSON.parse(JSON.stringify(object))))===JSON.stringify(scaledCurve)};
        }""")
        assert all(transforms.values()), transforms
        print("PASS movement and scaling update raw/display coordinates together while retaining metadata and vector shape")

        erasing = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          view={x:0,y:0,z:1,fit:false};draw();
          const object=pipelineBuild(Array.from({length:101},(_,i)=>pipelineSample(100+i*2,400+(i%2?0.6:-0.6),i,
            {pressure:0.25+i*0.005,tiltX:i%60,tiltY:10})));
          object.clipRegions=[[{x:80,y:380},{x:320,y:380},{x:320,y:420},{x:80,y:420}]];
          object.cutouts=[[{x:330,y:390},{x:340,y:390},{x:340,y:410},{x:330,y:410}]];
          // Keep an unrendered final raw lift so a surviving final point retains its associated raw tail.
          object.rawPoints.push({...object.rawPoints.at(-1),pressure:0,t:object.rawPoints.at(-1).t+8,endpoint:true});
          const original=JSON.parse(JSON.stringify(object));objects=[object];
          chooseTool('eraser');eraserMode='stroke';pipelineEvent('pointerdown',200,380,{time:5000});
          pipelineEvent('pointermove',200,420,{time:5008});pipelineEvent('pointerup',200,420,{time:5016});
          const pieces=JSON.parse(JSON.stringify(objects)),rawByTime=new Map(original.rawPoints.map(point=>[point.t,point]));
          const links=pieces.every(piece=>piece.points.every(point=>Number.isInteger(point.rawIndex)&&point.rawIndex>=0&&
            point.rawIndex<piece.rawPoints.length&&piece.rawPoints[point.rawIndex].t===point.t));
          const rawPreserved=pieces.every(piece=>piece.rawPoints.every(point=>JSON.stringify(point)===JSON.stringify(rawByTime.get(point.t))));
          const sliced=pieces.every(piece=>piece.rawPoints.length<original.rawPoints.length&&piece.points[0].rawIndex===0);
          const tail=pieces.find(piece=>piece.points.at(-1).t===original.points.at(-1).t);
          const tailRetained=Boolean(tail)&&tail.rawPoints.at(-1).endpoint===true&&tail.rawPoints.at(-1).pressure===0;
          const drawable=pieces.every(piece=>InkEngine.centerline(piece).every(point=>point.every(Number.isFinite)));
          const other=JSON.stringify(objects[1]),otherPixels=pipelinePixels(objects[1]);
          moveObject(objects[0],12,-6);scalePaperObject(objects[0],0.75);
          const pieceIsolation=other===JSON.stringify(objects[1])&&otherPixels===pipelinePixels(objects[1]);
          const transformed=JSON.stringify(objects);
          undo();const undoRestored=JSON.stringify(objects[0])===JSON.stringify(original);
          redo();const redoFixed=JSON.stringify(objects)===transformed;
          return {count:pieces.length,links,rawPreserved,sliced,tailRetained,drawable,pieceIsolation,undoRestored,redoFixed};
        }""")
        assert erasing["count"] == 2 and all(erasing[key] for key in ["links", "rawPreserved", "sliced", "tailRetained", "drawable", "pieceIsolation", "undoRestored", "redoFixed"]), erasing
        print("PASS partial erasing rebases raw links and keeps the correct pressure/tilt/time samples and final lift tail")

        editing_history = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          const object=pipelineBuild(Array.from({length:121},(_,i)=>pipelineSample(120+18*Math.cos(i/120*2*Math.PI),
            470+18*Math.sin(i/120*2*Math.PI),i,{pressure:0.3+i*0.003,tiltX:i%50,tiltY:15})));
          const raw=JSON.stringify(object.rawPoints),sourceByIndex=new Map(object.points.map(point=>[point.rawIndex,point]));
          const oldCount=object.points.length;objects=[object];selection={x:90,y:440,w:60,h:60};beautifySelection();
          const edited=objects[0],saved=JSON.stringify(edited);
          const metadata=edited.points.every(point=>{
            const source=sourceByIndex.get(point.rawIndex);
            return source&&['t','pressure','tiltX','tiltY'].every(key=>point[key]===source[key]);
          });
          const links=edited.points.every((point,i)=>Number.isInteger(point.rawIndex)&&point.rawIndex>=0&&point.rawIndex<edited.rawPoints.length&&
            (!i||point.rawIndex>=edited.points[i-1].rawIndex));
          const validDoc=lessonData();let reloadValid=true;try{validateDoc(JSON.parse(JSON.stringify(validDoc)));}catch{reloadValid=false;}
          const invalid=[doc=>{doc.objects[0].rawPoints[0].pressure=1.5;},
            doc=>{doc.objects[0].rawPoints[0].t=Infinity;},
            doc=>{doc.objects[0].points[1].rawIndex=doc.objects[0].rawPoints.length;}];
          const invalidRejected=invalid.every(change=>{
            const doc=JSON.parse(JSON.stringify(validDoc));change(doc);try{validateDoc(doc);return false;}catch{return true;}
          });
          const legacy=JSON.parse(JSON.stringify(validDoc));delete legacy.objects[0].rawPoints;
          legacy.objects[0].inkVersion=6;legacy.objects[0].points.forEach(point=>delete point.rawIndex);
          let legacyAccepted=true;try{validateDoc(legacy);}catch{legacyAccepted=false;}
          undo();const undoRawPreserved=raw===JSON.stringify(objects[0].rawPoints)&&objects[0].points.length===oldCount;
          redo();const redoFixed=saved===JSON.stringify(objects[0]);
          const sourceByTime=new Map([...sourceByIndex.values()].map(point=>[point.t,point]));
          chooseTool('eraser');eraserMode='stroke';pipelineEvent('pointerdown',120,440,{time:5100});
          pipelineEvent('pointermove',120,500,{time:5108});pipelineEvent('pointerup',120,500,{time:5116});
          const editedEraseLinks=objects.length>=2&&objects.every(piece=>piece.points.every((point,i)=>
            Number.isInteger(point.rawIndex)&&point.rawIndex>=0&&point.rawIndex<piece.rawPoints.length&&
            (!i||point.rawIndex>=piece.points[i-1].rawIndex)&&piece.rawPoints[point.rawIndex].t===point.t));
          const editedEraseMetadata=objects.every(piece=>piece.points.every(point=>{
            const source=sourceByTime.get(point.t);return source&&['t','pressure','tiltX','tiltY'].every(key=>source[key]===point[key]);
          }));
          let editedEraseValid=true;try{validateDoc(lessonData());}catch{editedEraseValid=false;}
          return {actuallyEdited:edited.points.length!==oldCount,rawPreserved:raw===JSON.stringify(edited.rawPoints),
            metadata,links,reloadValid,invalidRejected,legacyAccepted,undoRawPreserved,redoFixed,
            editedEraseLinks,editedEraseMetadata,editedEraseValid};
        }""")
        assert all(editing_history.values()), editing_history
        print("PASS manual curve editing preserves capture history and validates saved raw links without excluding legacy ink")

        render_object = page.evaluate("""() => pipelineBuild(Array.from({length:151},(_,i)=>
          pipelineSample(40+i*1.6,170+15*Math.sin(i/17),i,{pressure:0.3+i*0.003,tiltX:30,tiltY:15})))""")
        render_js = """object => {
          const dpr=window.devicePixelRatio,cssWidth=360,cssHeight=280,surface=document.createElement('canvas');
          surface.style.width=cssWidth+'px';surface.style.height=cssHeight+'px';surface.width=cssWidth*dpr;surface.height=cssHeight*dpr;
          const context=surface.getContext('2d');context.setTransform(dpr,0,0,dpr,0,0);paintObject(context,object);
          const pixels=context.getImageData(0,0,surface.width,surface.height).data;
          let alpha=0;for(let i=3;i<pixels.length;i+=4)alpha+=pixels[i]/255;
          const rect=canvas.getBoundingClientRect();
          return {dpr,width:surface.width,height:surface.height,coverage:alpha/(dpr*dpr),centers:InkEngine.centerline(object),
            boardBackingCorrect:Math.abs(canvas.width-rect.width*dpr)<=0.5&&Math.abs(canvas.height-rect.height*dpr)<=0.5};
        }"""
        render_two = page.evaluate(render_js, render_object)
        context_three = browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=3)
        page_three = context_three.new_page()
        page_three.on("pageerror", lambda error: errors.append(str(error)))
        prepare(page_three)
        render_three = page_three.evaluate(render_js, render_object)
        assert render_two["dpr"] == 2 and render_three["dpr"] == 3
        assert render_two["width"] == 720 and render_three["width"] == 1080
        assert render_two["height"] == 560 and render_three["height"] == 840
        assert render_two["boardBackingCorrect"] and render_three["boardBackingCorrect"], (render_two, render_three)
        assert render_two["centers"] == render_three["centers"], (render_two, render_three)
        assert abs(render_two["coverage"] - render_three["coverage"]) <= render_two["coverage"] * 0.03, (render_two, render_three)
        context_three.close()
        print("PASS DPR2/3 canvas backing sizes and fresh vector rendering preserve shape and CSS ink coverage")

        before_dpr_change = page.evaluate("""() => ({vectors:JSON.stringify(objects),
          centers:JSON.stringify(objects.map(object=>InkEngine.centerline(object)))})""")
        page.evaluate("""() => {
          window.pipelineDprProbe={resize:0,media:0};
          window.addEventListener('resize',()=>pipelineDprProbe.resize++);
          const query=matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
          query.addEventListener('change',()=>pipelineDprProbe.media++);window.pipelineProbeQuery=query;
        }""")
        cdp = page.context.new_cdp_session(page)
        dpr_changes, native_dpr_events = [], []
        for dpr in [3, 2]:
            cdp.send("Emulation.setDeviceMetricsOverride", {
                "width": 1440, "height": 1000, "deviceScaleFactor": dpr, "mobile": False,
            })
            page.wait_for_function("expected=>devicePixelRatio===expected", arg=dpr)
            page.wait_for_timeout(150)
            native_dpr_events.append(page.evaluate("""() => {
              const rect=canvas.getBoundingClientRect();return {...pipelineDprProbe,dpr:devicePixelRatio,
                queryMatches:pipelineProbeQuery.matches,backingReady:Math.abs(canvas.width-rect.width*devicePixelRatio)<=0.5&&
                  Math.abs(canvas.height-rect.height*devicePixelRatio)<=0.5};
            }"""))
            # CDP changes DPR without dispatching resize/MQL events in some Chrome versions.
            # Ordinary scrolling must still render at the current resolution; never call resize().
            page.evaluate("""() => canvas.dispatchEvent(new WheelEvent('wheel',
              {bubbles:true,cancelable:true,deltaY:12}))""")
            try:
                page.wait_for_function("""expected => {
                  const rect=canvas.getBoundingClientRect();
                  return devicePixelRatio===expected&&Math.abs(canvas.width-rect.width*expected)<=0.5&&
                    Math.abs(canvas.height-rect.height*expected)<=0.5;
                }""", arg=dpr, polling=100, timeout=5000)
            except Exception as failure:
                state = page.evaluate("""() => {
                  const rect=canvas.getBoundingClientRect();return {dpr:devicePixelRatio,visibility:document.visibilityState,
                    width:canvas.width,height:canvas.height,cssWidth:rect.width,cssHeight:rect.height,
                    query:inkResolutionQuery.media,queryMatches:inkResolutionQuery.matches};
                }""")
                raise AssertionError({"expectedDpr": dpr, "actual": state}) from failure
            dpr_changes.append(page.evaluate("""() => ({dpr:devicePixelRatio,vectors:JSON.stringify(objects),
              centers:JSON.stringify(objects.map(object=>InkEngine.centerline(object)))})"""))
        assert [result["dpr"] for result in dpr_changes] == [3, 2], dpr_changes
        assert all(result["vectors"] == before_dpr_change["vectors"] and result["centers"] == before_dpr_change["centers"]
                   for result in dpr_changes), dpr_changes
        cdp.detach()
        print("PASS same-page DPR3-to-2 ordinary rendering uses the current backing resolution without changing saved vectors")

        if os.environ.get("ST_WEB_PIPELINE_REPORT"):
            print(json.dumps({"adaptive": adaptive, "loops": loops, "prediction": prediction, "erasing": erasing,
                              "dprCoverage": [render_two["coverage"], render_three["coverage"]], "nativeDprEvents": native_dpr_events}, indent=2))
        assert not errors, errors
        browser.close()
        print("Input pipeline checks passed.")


if __name__ == "__main__":
    run()
