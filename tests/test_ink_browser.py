"""Run: python tests/test_ink_browser.py (Python Playwright + Chrome).
Browser integration, vector rendering and input checks; HTTP/saves are mocked.
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
        page.add_init_script("""
          sessionStorage.setItem('qh-authenticated', 'true');
          // The automatic profile must ignore preferences from earlier builds.
          localStorage.setItem('bangtrang-handwriting-scale', '0.4');
          localStorage.setItem('bangtrang-inkStability', '100');
          localStorage.setItem('bangtrang-inkPressure', '0');
        """)

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
        removed_controls = ["inkStability", "inkPressure", "handwritingScale", "strokeWidth",
                            "decreaseStrokeWidth", "increaseStrokeWidth", "resetView"]
        assert all(page.locator(f"#{control}").count() == 0 for control in removed_controls)
        assert page.evaluate("typeof handwritingScale") == "undefined"
        assert page.evaluate("typeof inkSettings") == "undefined"
        assert page.evaluate("color") == "#24304a"
        assert page.evaluate("typeof PerfectFreehand.getStroke") == "function"

        automatic_view = page.evaluate("({...view})")
        assert automatic_view["fit"] is False and automatic_view["z"] == 1, automatic_view
        assert page.locator("#zoomPercent").text_content() == "100%"
        zoom_behavior = page.evaluate("""() => {
          for(let i=0;i<15;i++)$("zoomIn").click();
          const maximum={z:view.z,label:$("zoomPercent").value,disabled:$("zoomIn").disabled};
          for(let i=0;i<15;i++)$("zoomOut").click();
          const minimum={z:view.z,label:$("zoomPercent").value,disabled:$("zoomOut").disabled};
          for(let i=0;i<5;i++)$("zoomIn").click();
          return {maximum,minimum,restored:{z:view.z,label:$("zoomPercent").value}};
        }""")
        assert zoom_behavior == {
            "maximum": {"z": 2, "label": "200%", "disabled": True},
            "minimum": {"z": 0.5, "label": "50%", "disabled": True},
            "restored": {"z": 1, "label": "100%"},
        }, zoom_behavior
        restored_view = page.evaluate("""() => {
          const doc=lessonData();doc.view={x:300,y:-180,z:1.4,fit:false};
          applyDoc(validateDoc(doc));draw();return {...view};
        }""")
        assert restored_view["fit"] is False and abs(restored_view["z"] - 1.4) < 0.001, restored_view
        wheel_view = page.evaluate("""() => {
          const before={...view};
          canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-180}));
          const ctrl={...view};
          canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,metaKey:true,deltaY:180}));
          const meta={...view};
          canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100}));
          const scroll={...view};view={...before};draw();return {before,ctrl,meta,scroll};
        }""")
        assert wheel_view["ctrl"] == wheel_view["before"] and wheel_view["meta"] == wheel_view["before"], wheel_view
        assert wheel_view["scroll"]["z"] == wheel_view["before"]["z"], wheel_view
        assert wheel_view["scroll"]["y"] < wheel_view["before"]["y"], wheel_view
        print("PASS 100% default, bounded zoom controls, saved zoom restoration and ignored legacy ink settings")

        metrics = page.evaluate("""() => {
          const input=extra=>InkEngine.createInput({pointerType:'pen',type:'pen',scale:1,...extra});
          const smooth=input(),a=[],b=[];
          for(let i=0;i<150;i++) {
            const sample={x:100+i*0.7,y:250+(i%2?1.5:-1.5),time:i*8,pressure:0.5};
            a.push(smooth.sample(sample));b.push(sample);
          }
          const jitter=points=>points.slice(10).reduce((total,p,i)=>total+Math.abs(p.y-points[i+9].y),0)/140;
          const low=input(),high=input(),tilted=input(),legacy=input({stability:1,sensitivity:0});
          const l=low.sample({x:0,y:0,time:0,pressure:0.1});
          const h=high.sample({x:0,y:0,time:0,pressure:0.9});
          const t=tilted.sample({x:0,y:0,time:0,pressure:0.9,tiltX:60,tiltY:30});
          const c=legacy.sample({x:0,y:0,time:0,pressure:0.1});
          const end=high.sample({x:5,y:0,time:8,pressure:0},true);
          const fast=input(),slow=input(),mouse=input({pointerType:'mouse'}),samples=[];
          let f,s;
          for(let i=0;i<40;i++) {
            f=fast.sample({x:i*10,y:0,time:i*8,pressure:0.5});
            s=slow.sample({x:i*0.5,y:0,time:i*8,pressure:0.5});
            samples.push(f.p,s.p,mouse.sample({x:i*2,y:0,time:i*8,pressure:i%2?0:1}).p);
          }
          const fixed=InkEngine.strokeOptions({},'pen','pen');
          const old=InkEngine.strokeOptions({stability:1,sensitivity:0},'pen','pen');
          const scaled=InkEngine.strokeOptions({scale:2},'pen','pen');
          return {jitterSmooth:jitter(a),jitterRaw:jitter(b),low:l.p,high:h.p,tilted:t.p,
            legacy:c.p,lift:end.p,lag:390-f.x,fast:f.p,slow:s.p,
            min:Math.min(l.p,h.p,t.p,...samples),max:Math.max(l.p,h.p,t.p,...samples),fixed,old,scaled};
        }""")
        assert metrics["jitterSmooth"] < metrics["jitterRaw"] * 0.6, metrics
        assert metrics["high"] > metrics["low"] and metrics["high"] / metrics["low"] < 1.34, metrics
        assert metrics["tilted"] > metrics["high"], metrics
        assert metrics["legacy"] == metrics["low"] and metrics["lift"] == metrics["high"], metrics
        assert metrics["lag"] < 1 and metrics["fast"] < metrics["slow"], metrics
        assert 0.86 <= metrics["min"] <= metrics["max"] <= 1.14, metrics
        assert metrics["fixed"] == metrics["old"], metrics
        assert 0.6 <= metrics["fixed"]["smoothing"] <= 0.7
        assert metrics["fixed"]["streamline"] == 0 and metrics["fixed"]["simulatePressure"] is False
        assert metrics["fixed"]["thinning"] == 1 and metrics["fixed"]["rounding"] == 1.2
        assert metrics["scaled"]["rounding"] == 0.6
        print("PASS automatic jitter filtering, low input lag and restrained pressure/tilt/speed width")

        prediction = page.evaluate("""() => {
          const build=(extra={})=>{
            const input=InkEngine.createInput({pointerType:'pen',type:'pen',scale:1,...extra});
            const samples=[];
            for(let i=0;i<8;i++)samples.push(input.sample({x:100+i*3,y:200,time:1000+i*8,
              pressure:0.6,tiltX:30,tiltY:15}));
            return {input,samples,last:samples[samples.length-1]};
          };
          const a=build(),b=build(),actual=JSON.stringify(a.samples);
          const fallback=a.input.predict();
          const native=a.input.predict([{x:150,y:200,time:1064,pressure:1,tiltX:80}]);
          const invalid=a.input.predict([{x:100000,y:-100000,time:999999}]);
          const next={x:124,y:200,time:1064,pressure:0.7,tiltX:25,tiltY:10};
          const unchanged=JSON.stringify(a.input.sample(next))===JSON.stringify(b.input.sample(next));
          const stopped=build();stopped.input.sample({x:121,y:200,time:1064,pressure:0.6});
          const reversed=build();reversed.input.sample({x:115,y:200,time:1064,pressure:0.6});
          const gap=build();gap.input.sample({x:124,y:200,time:1110,pressure:0.6});
          const single=InkEngine.createInput({pointerType:'pen',type:'pen',scale:1});
          single.sample({x:10,y:10,time:0,pressure:0.5});
          const scaled=build({scale:0.5});
          return {last:a.last,fallback,native,invalid,unchanged,samplesUnchanged:actual===JSON.stringify(a.samples),
            stopped:stopped.input.predict(),reversed:reversed.input.predict(),gap:gap.input.predict(),
            single:single.predict(),mouse:build({pointerType:'mouse'}).input.predict(),
            highlight:build({type:'highlight'}).input.predict(),scaledLast:scaled.last,scaled:scaled.input.predict()};
        }""")
        assert prediction["unchanged"] and prediction["samplesUnchanged"], prediction
        for name in ["fallback", "native"]:
            point, last = prediction[name], prediction["last"]
            assert point and 0 < point["x"] - last["x"] <= 2.001, prediction
            assert abs(point["y"] - last["y"]) < 0.001, prediction
            assert all(point[key] == last[key] for key in ["p", "pressure", "tiltX", "tiltY"]), prediction
        if prediction["invalid"]:
            assert ((prediction["invalid"]["x"] - prediction["last"]["x"]) ** 2
                    + (prediction["invalid"]["y"] - prediction["last"]["y"]) ** 2) ** 0.5 <= 2.001, prediction
        assert all(prediction[name] is None for name in ["stopped", "reversed", "gap", "single", "mouse", "highlight"]), prediction
        assert prediction["scaled"] and 0 < (prediction["scaled"]["x"] - prediction["scaledLast"]["x"]) * 0.5 <= 2.001, prediction
        print("PASS bounded pen prediction is nonmutating and stops at pauses, reversals and sample gaps")

        rounding = page.evaluate("""() => {
          const points=[{x:20,y:70,p:0.86},{x:50,y:20,p:1},{x:80,y:70,p:1.14}];
          const object={type:'pen',inkVersion:4,width:1.6,points,
            inkOptions:InkEngine.strokeOptions({},'pen','pen')};
          const rounded=InkEngine.centerline(object),box=bounds(object);
          scalePaperObject(object,0.5);
          const scaled=InkEngine.centerline(object);
          const scaledMatches=rounded.every((p,i)=>Math.abs(scaled[i][0]-(box.x+(p[0]-box.x)*0.5))<1e-7
            &&Math.abs(scaled[i][1]-(box.y+(p[1]-box.y)*0.5))<1e-7&&scaled[i][2]===p[2]);
          return {points:rounded,apexDistance:Math.min(...rounded.map(p=>Math.hypot(p[0]-50,p[1]-20))),
            minY:Math.min(...rounded.map(p=>p[1])),scaledMatches};
        }""")
        assert rounding["points"][0][:2] == [20, 70] and rounding["points"][-1][:2] == [80, 70], rounding
        assert 0 < rounding["apexDistance"] <= 1.3 and 20 < rounding["minY"] < 21.3, rounding
        assert all(0.43 <= point[2] <= 0.57 for point in rounding["points"]), rounding
        assert rounding["scaledMatches"], rounding
        print("PASS bounded corner rounding, exact endpoints and proportional document scaling")

        spline = page.evaluate("""() => {
          const points=[{x:20,y:60,p:0.86},{x:40,y:40,p:1},{x:70,y:35,p:1.14},
            {x:100,y:50,p:1},{x:120,y:70,p:0.86}];
          const object={type:'pen',inkVersion:5,width:1.6,points,
            inkOptions:InkEngine.strokeOptions({},'pen','pen')};
          const original=JSON.stringify(points);
          const centers=InkEngine.centerline(object);
          const distance=(p,a,b)=>{
            const dx=b.x-a.x,dy=b.y-a.y;
            const t=Math.max(0,Math.min(1,((p[0]-a.x)*dx+(p[1]-a.y)*dy)/(dx*dx+dy*dy)));
            return Math.hypot(p[0]-a.x-t*dx,p[1]-a.y-t*dy);
          };
          const deviation=Math.max(...centers.map(p=>Math.min(...points.slice(1).map((b,i)=>distance(p,points[i],b)))));
          const sourceUnchanged=original===JSON.stringify(object.points);
          const box=bounds(object);scalePaperObject(object,0.5);
          const scaled=InkEngine.centerline(object);
          const scaledMatches=centers.length===scaled.length&&centers.every((p,i)=>
            Math.abs(scaled[i][0]-(box.x+(p[0]-box.x)*0.5))<1e-7
            &&Math.abs(scaled[i][1]-(box.y+(p[1]-box.y)*0.5))<1e-7&&Math.abs(scaled[i][2]-p[2])<1e-7);
          return {centers,deviation,sourceUnchanged,scaledMatches};
        }""")
        assert len(spline["centers"]) > 5, spline
        assert spline["centers"][0][:2] == [20, 60] and spline["centers"][-1][:2] == [120, 70], spline
        assert spline["sourceUnchanged"] and spline["scaledMatches"] and 0 < spline["deviation"] <= 2.5, spline
        assert all(all(isinstance(value, (int, float)) and abs(value) < 1000 for value in point)
                   and 0.4299999 <= point[2] <= 0.5700001 for point in spline["centers"]), spline
        print("PASS cubic interpolation preserves endpoints, bounded shape and proportional vector scaling")

        # Use trusted Chrome stylus events before the synthetic input scenarios.
        cdp = page.context.new_cdp_session(page)
        coordinates = page.evaluate("""() => {
          const r=canvas.getBoundingClientRect();
          return [r.left+view.x+120*view.z,r.top+view.y+220*view.z,view.z];
        }""")
        cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": coordinates[0], "y": coordinates[1],
            "button": "left", "buttons": 1, "clickCount": 1, "pointerType": "pen", "force": 0.7, "tiltX": 35, "tiltY": 20})
        assert page.evaluate("start.pointerType") == "pen"
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": coordinates[0]+60*coordinates[2],
            "y": coordinates[1]+25*coordinates[2], "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.8, "tiltX": 40})
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": coordinates[0]+65*coordinates[2],
            "y": coordinates[1]+30*coordinates[2], "button": "left", "buttons": 0, "clickCount": 1, "pointerType": "pen", "force": 0})
        trusted = page.evaluate("JSON.parse(JSON.stringify(objects))")
        assert len(trusted) == 1 and trusted[0]["points"][0]["tiltX"] == 35
        assert abs(trusted[0]["points"][0]["pressure"] - 0.7) < 0.001
        assert abs(trusted[0]["rawPoints"][-1]["x"] - 185) < 0.001, trusted
        assert abs(trusted[0]["rawPoints"][-1]["y"] - 250) < 0.001, trusted
        assert trusted[0]["rawPoints"][-1]["pressure"] == 0, trusted
        assert trusted[0]["rawPoints"][0]["tiltX"] == 35
        assert abs(trusted[0]["rawPoints"][0]["pressure"] - 0.7) < 0.001
        assert trusted[0]["points"][0]["x"] == trusted[0]["rawPoints"][0]["x"]
        assert trusted[0]["points"][0]["y"] == trusted[0]["rawPoints"][0]["y"]
        assert all(math.hypot(point["x"] - trusted[0]["rawPoints"][point["rawIndex"]]["x"],
                             point["y"] - trusted[0]["rawPoints"][point["rawIndex"]]["y"]) * coordinates[2] <= 0.901
                   for point in trusted[0]["points"]), trusted
        assert any(math.hypot(point["x"] - trusted[0]["rawPoints"][point["rawIndex"]]["x"],
                             point["y"] - trusted[0]["rawPoints"][point["rawIndex"]]["y"]) > 1e-6
                   for point in trusted[0]["points"][1:]), trusted
        current_version = page.evaluate("InkEngine.profile.version")
        assert current_version >= 8
        assert trusted[0]["inkVersion"] == current_version and trusted[0]["color"] == "#24304a", trusted
        assert abs(trusted[0]["width"] * coordinates[2] - 1.6) < 0.001, trusted
        print("PASS trusted stylus raw acquisition, thin charcoal ink and bounded adaptive display lag")

        page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          view={x:0,y:0,z:1,fit:false};chooseTool('pen');draw();
          // Synthetic pointer IDs are not captured by the browser; dispatch all
          // events to the board explicitly while exercising the production handlers.
          canvas.setPointerCapture=()=>{};
          window.inkEvent=(type,x,y,options={})=>{
            const rect=canvas.getBoundingClientRect();
            const {inkTime,inkPredicted,...pointerOptions}=options;
            const event=new PointerEvent(type,{bubbles:true,pointerId:7,pointerType:'pen',
              button:0,buttons:type==='pointerup'?0:1,pressure:0.5,
              clientX:rect.left+view.x+x*view.z,clientY:rect.top+view.y+y*view.z,...pointerOptions});
            if(Number.isFinite(inkTime))Object.defineProperty(event,'timeStamp',{value:inkTime});
            if(inkPredicted)Object.defineProperty(event,'getPredictedEvents',{value:()=>inkPredicted.map(point=>({
              pointerId:event.pointerId,pointerType:event.pointerType,
              clientX:rect.left+view.x+point.x*view.z,clientY:rect.top+view.y+point.y*view.z,
              timeStamp:point.time,pressure:point.pressure??1,tiltX:point.tiltX??80,tiltY:point.tiltY??80}))});
            canvas.dispatchEvent(event);
          };
          inkEvent('pointerdown',100,240,{pressure:0.15});
          const original=JSON.stringify(active);
          inkEvent('pointerdown',140,270,{pointerId:8,pointerType:'touch'});
          inkEvent('pointermove',400,450,{pointerId:8,pointerType:'touch'});
          inkEvent('pointerup',400,450,{pointerId:8,pointerType:'touch'});
          if(JSON.stringify(active)!==original||!dragging)throw Error('Palm changed the pen stroke');
          const coalesced=[120,140,160].map((x,i)=>new PointerEvent('pointermove',{
            pointerType:'pen',pressure:0.3+i*0.2,tiltX:30,tiltY:10,
            clientX:canvas.getBoundingClientRect().left+view.x+x*view.z,
            clientY:canvas.getBoundingClientRect().top+view.y+(240+i*8)*view.z}));
          const batch=new PointerEvent('pointermove',{pointerId:7,pointerType:'pen'});
          Object.defineProperty(batch,'getCoalescedEvents',{value:()=>coalesced});
          canvas.dispatchEvent(batch);
        }""")
        page.wait_for_timeout(50)
        assert page.locator("#welcome").is_hidden()
        assert page.evaluate("active.points.length") == 4
        assert page.evaluate("active.rawPoints.length") == 4
        page.evaluate("inkEvent('pointerup',210,270,{pressure:0})")
        state = page.evaluate("JSON.parse(JSON.stringify(objects))")
        assert len(state) == 1 and state[0]["inkVersion"] == current_version
        assert abs(state[0]["width"] - 1.6) < 0.001
        assert state[0]["rawPoints"][-1]["x"] == 210 and state[0]["rawPoints"][-1]["y"] == 270
        assert state[0]["rawPoints"][-1]["pressure"] == 0
        assert state[0]["points"][0]["x"] == state[0]["rawPoints"][0]["x"] == 100
        assert state[0]["points"][0]["y"] == state[0]["rawPoints"][0]["y"] == 240
        assert all(math.hypot(point["x"] - state[0]["rawPoints"][point["rawIndex"]]["x"],
                             point["y"] - state[0]["rawPoints"][point["rawIndex"]]["y"]) <= 0.901
                   for point in state[0]["points"]), state
        assert any(math.hypot(point["x"] - state[0]["rawPoints"][point["rawIndex"]]["x"],
                             point["y"] - state[0]["rawPoints"][point["rawIndex"]]["y"]) > 1e-6
                   for point in state[0]["points"][1:]), state
        assert [(point["x"], point["y"]) for point in state[0]["rawPoints"][1:-1]] == [(120, 240), (140, 248), (160, 256)]
        assert all(point["tiltX"] == 30 and point["tiltY"] == 10 for point in state[0]["rawPoints"][1:-1])
        assert state[0]["points"][-1]["p"] == state[0]["points"][-2]["p"]
        assert state[0]["points"][1]["tiltX"] == 30
        assert state[0]["inkOptions"]["streamline"] == 0
        assert state[0]["inkOptions"]["simulatePressure"] is False
        page.evaluate("undo()")
        assert page.evaluate("objects.length") == 0
        page.evaluate("redo()")
        assert page.evaluate("JSON.parse(JSON.stringify(objects))") == state
        page.evaluate("saveLesson()")
        assert saves[-1]["objects"] == state
        page.evaluate("data=>{validateDoc(data);objects=JSON.parse(JSON.stringify(data.objects));draw()}", saves[-1])
        print("PASS coalesced raw samples, palm rejection, bounded filtered lift, undo/redo and vector save/restore")

        preview_state = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          view={x:0,y:0,z:1,fit:false};chooseTool('pen');draw();
          inkEvent('pointerdown',100,300,{inkTime:2000,pressure:0.6,tiltX:30,tiltY:15});
          const predict=start.inkInput.predict,predictionCalls=[];
          start.inkInput.predict=points=>{predictionCalls.push(points);return predict(points)};
          for(let i=1;i<=7;i++)inkEvent('pointermove',100+i*3,300,{
            inkTime:2000+i*8,pressure:0.6,tiltX:30,tiltY:15,
            inkPredicted:i===7?[{x:135,y:300,time:2064}]:[]});
          return {actual:JSON.parse(JSON.stringify(active)),
            preview:start.inkPreview?JSON.parse(JSON.stringify(start.inkPreview)):null,
            predictedArguments:predictionCalls[predictionCalls.length-1]};
        }""")
        actual_points = preview_state["actual"]["points"]
        actual_raw = preview_state["actual"]["rawPoints"]
        assert preview_state["preview"], preview_state
        assert preview_state["predictedArguments"][0]["x"] == 135 and preview_state["predictedArguments"][0]["time"] == 2064, preview_state
        preview_points = preview_state["preview"]["points"]
        assert len(preview_points) == len(actual_points) + 1, preview_state
        assert preview_points[:-1] == actual_points, preview_state
        assert preview_state["preview"]["rawPoints"] == actual_raw, preview_state
        assert 0 < preview_points[-1]["x"] - actual_points[-1]["x"] <= 2.001, preview_state
        assert all(preview_points[-1][key] == actual_points[-1][key]
                   for key in ["p", "pressure", "tiltX", "tiltY"]), preview_state
        page.wait_for_timeout(70)
        assert page.evaluate("!start.inkPreview")
        assert page.evaluate("JSON.parse(JSON.stringify(active.points))") == actual_points
        assert page.evaluate("JSON.parse(JSON.stringify(active.rawPoints))") == actual_raw
        committed_prediction = page.evaluate("""() => {
          inkEvent('pointermove',124,300,{inkTime:2064,pressure:0.6,tiltX:30,tiltY:15,
            inkPredicted:[{x:140,y:300,time:2072}]});
          if(!start.inkPreview)throw Error('The resumed pen did not predict');
          const actual=JSON.stringify(active.points);
          const rawBefore=JSON.parse(JSON.stringify(active.rawPoints));
          inkEvent('pointerup',124,300,{inkTime:2072,pressure:0});
          return {actual,rawBefore,stored:JSON.stringify(objects[0].points),
            storedRaw:JSON.parse(JSON.stringify(objects[0].rawPoints)),
            object:JSON.parse(JSON.stringify(objects[0])),previewCleared:!start?.inkPreview};
        }""")
        assert committed_prediction["actual"] == committed_prediction["stored"] and committed_prediction["previewCleared"], committed_prediction
        assert committed_prediction["storedRaw"][:-1] == committed_prediction["rawBefore"], committed_prediction
        assert committed_prediction["storedRaw"][-1]["x"] == 124 and committed_prediction["storedRaw"][-1]["y"] == 300
        assert committed_prediction["storedRaw"][-1]["pressure"] == 0 and committed_prediction["storedRaw"][-1]["t"] == 2072
        page.evaluate("saveLesson()")
        assert saves[-1]["objects"][0]["points"] == json.loads(committed_prediction["actual"])
        assert saves[-1]["objects"][0] == committed_prediction["object"]
        page.evaluate("undo();redo()")
        assert page.evaluate("JSON.stringify(objects[0].points)") == committed_prediction["actual"]
        assert page.evaluate("JSON.parse(JSON.stringify(objects[0]))") == committed_prediction["object"]
        print("PASS native prediction preview expires and never enters committed ink, saves or undo history")

        pointer_lift = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];
          view={x:0,y:0,z:1,fit:false};chooseTool('pen');draw();
          inkEvent('pointerdown',100,350,{pressure:0.6});
          inkEvent('pointermove',110,355,{pressure:0.6});
          inkEvent('pointermove',120,360,{pressure:0.6});
          const before=JSON.stringify(active.points);
          const tail={...active.points[active.points.length-1]};
          inkEvent('pointermove',120,360,{pressure:0.6});
          const stationary=JSON.stringify(active.points);
          const rawBefore=JSON.parse(JSON.stringify(active.rawPoints));
          inkEvent('pointerup',120,360,{pressure:0});
          const committed=JSON.stringify(objects[0].points);
          const rawCommitted=JSON.parse(JSON.stringify(objects[0].rawPoints));
          chooseTool('highlight');inkEvent('pointerdown',100,400);
          inkEvent('pointermove',140,400);inkEvent('pointerup',140,400);
          const highlight=objects[1];
          chooseTool('pen');return {before,stationary,committed,rawBefore,rawCommitted,tail,highlight};
        }""")
        assert pointer_lift["stationary"] == pointer_lift["committed"], pointer_lift
        assert pointer_lift["rawCommitted"][:-1] == pointer_lift["rawBefore"], pointer_lift
        assert pointer_lift["rawCommitted"][-1]["x"] == 120 and pointer_lift["rawCommitted"][-1]["y"] == 360
        assert pointer_lift["rawCommitted"][-1]["pressure"] == 0
        assert pointer_lift["highlight"]["inkVersion"] == current_version and pointer_lift["highlight"]["width"] == 3
        print("PASS stationary lift preserves the live stroke without an added hook; automatic highlighter width")

        pinch = page.evaluate("""() => {
          clearBoardInteraction();objects=[];view={x:0,y:0,z:1,fit:true};draw();
          const z=view.z;
          inkEvent('pointerdown',160,330,{pointerType:'touch',pointerId:9});
          inkEvent('pointerdown',220,330,{pointerType:'touch',pointerId:10});
          inkEvent('pointermove',300,330,{pointerType:'touch',pointerId:10});
          const after=view.z;
          inkEvent('pointerup',160,330,{pointerType:'touch',pointerId:9});
          inkEvent('pointerup',300,330,{pointerType:'touch',pointerId:10});
          const count=objects.length;
          clearBoardInteraction();objects=[];view={x:0,y:0,z:1,fit:false};draw();
          return {z,after,count};
        }""")
        assert pinch["z"] == pinch["after"] and pinch["count"] == 0, pinch
        print("PASS touch pinch keeps the automatic viewing scale and commits no accidental ink")

        page.evaluate("""() => {
          const original=JSON.stringify(objects);
          inkEvent('pointerdown',300,300);inkEvent('pointermove',340,350);
          inkEvent('pointercancel',340,350);
          if(dragging||active||JSON.stringify(objects)!==original)throw Error('Cancelled stroke committed');
          inkEvent('pointerdown',300,300,{pointerType:'touch',pointerId:9});
          inkEvent('pointerdown',100,320);
          if(start.pointerType!=='pen'||active.points[0].x!==100)throw Error('Palm blocked the pen');
          inkEvent('pointerup',130,330);
        }""")
        print("PASS pointer cancellation and pen priority over an existing touch")

        alpha_metrics = page.evaluate("""() => {
          const object={type:'highlight',inkVersion:4,color:'#ffb400',width:3,
            points:[{x:40,y:100,p:1},{x:80,y:100,p:1},{x:120,y:100,p:1},{x:160,y:100,p:1}]};
          const c=document.createElement('canvas');c.width=200;c.height=200;
          const context=c.getContext('2d');paintObject(context,object);
          return [50,80,100,120,150].map(x=>context.getImageData(x,100,1,1).data[3]);
        }""")
        assert max(alpha_metrics) - min(alpha_metrics) <= 1 and 75 <= min(alpha_metrics) <= 78, alpha_metrics
        print("PASS highlighter has uniform opacity across segment joins")

        details = page.evaluate("""() => {
          const c=document.createElement('canvas');c.width=100;c.height=100;
          const context=c.getContext('2d');
          const pen={type:'pen',inkVersion:InkEngine.profile.version,color:'#24304a',width:1.6,
            inkOptions:InkEngine.strokeOptions({},'pen','pen'),
            points:[{x:20,y:20,p:1}]};
          paintObject(context,pen);const dot=context.getImageData(20,20,1,1).data[3];
          context.clearRect(0,0,100,100);
          pen.points=Array.from({length:81},(_,i)=>({x:50+10*Math.cos(i/80*2*Math.PI),
            y:50+10*Math.sin(i/80*2*Math.PI),p:1}));
          paintObject(context,pen);
          const center=context.getImageData(50,50,1,1).data[3];
          const edge=Math.max(context.getImageData(59,50,1,1).data[3],context.getImageData(60,50,1,1).data[3]);
          const original=PerfectFreehand.getStroke;let calls=0;
          PerfectFreehand.getStroke=(...args)=>{calls++;return original(...args)};
          const long={...pen,points:Array.from({length:3000},(_,i)=>({x:10+i*0.02,y:50+10*Math.sin(i/40),p:1}))};
          const before=performance.now();paintObject(context,long);const ms=performance.now()-before;
          paintObject(context,long);paintObject(context,long);
          PerfectFreehand.getStroke=original;
          return {dot,center,edge,calls,ms};
        }""")
        assert details["dot"] > 150 and details["center"] == 0 and details["edge"] > 100, details
        assert details["calls"] == 1, details
        print(f'PASS precise dots, small handwriting loops and cached 3000-sample stroke ({details["ms"]:.1f} ms)')

        thin_widths = page.evaluate("""() => {
          const c=document.createElement('canvas');c.width=120;c.height=100;
          const context=c.getContext('2d');
          return ['pen','mouse'].map(pointerType=>{
            const input=InkEngine.createInput({pointerType,type:'pen',scale:1});
            const points=Array.from({length:81},(_,i)=>input.sample({x:10+i,y:50,time:i*8,
              pressure:i<40?0.1:0.9,tiltX:15}));
            const pen={type:'pen',inkVersion:InkEngine.profile.version,color:'#24304a',width:1.6,
              inkOptions:InkEngine.strokeOptions({},pointerType,'pen'),points};
            context.clearRect(0,0,120,100);paintObject(context,pen);
            const thickness=[30,70].map(x=>{
              const data=context.getImageData(x,0,1,100).data;
              let coverage=0,rows=0;
              for(let i=3;i<data.length;i+=4){coverage+=data[i]/255;if(data[i])rows++;}
              return {coverage,rows};
            });
            return {pointerType,thickness,min:Math.min(...points.map(p=>p.p)),max:Math.max(...points.map(p=>p.p))};
          });
        }""")
        assert all(0.86 <= result["min"] <= result["max"] <= 1.14 for result in thin_widths), thin_widths
        assert all(1 <= width["coverage"] <= 2.1 and width["rows"] <= 4
                   for result in thin_widths for width in result["thickness"]), thin_widths
        print("PASS pen and mouse produce readable thin strokes with bounded thickness")

        taper = page.evaluate("""() => {
          const c=document.createElement('canvas');c.width=220;c.height=160;
          const context=c.getContext('2d');
          const object=(version,points)=>({type:'pen',inkVersion:version,color:'#24304a',width:8,
            inkOptions:InkEngine.strokeOptions({},'pen','pen'),points});
          const draw=(version,points)=>{
            context.clearRect(0,0,220,160);paintObject(context,object(version,points));
            const coverage=x=>{
              const data=context.getImageData(x,0,1,160).data;
              let total=0;for(let i=3;i<data.length;i+=4)total+=data[i]/255;return total;
            };
            return {pixels:c.toDataURL(),start:coverage(40),end:coverage(159),body:coverage(100)};
          };
          const line=Array.from({length:121},(_,i)=>({x:40+i,y:100,p:1}));
          const old=draw(4,line),current=draw(InkEngine.profile.version,line);
          const dot=[{x:60,y:60,p:1}],accent=[{x:60,y:60,p:1},{x:64,y:60,p:1}];
          return {old,current,dotIdentical:draw(4,dot).pixels===draw(InkEngine.profile.version,dot).pixels,
            accentIdentical:draw(4,accent).pixels===draw(InkEngine.profile.version,accent).pixels};
        }""")
        assert taper["dotIdentical"] and taper["accentIdentical"], taper
        assert abs(taper["current"]["body"] - taper["old"]["body"]) <= 0.1, taper
        assert all(taper["old"][edge] * 0.7 <= taper["current"][edge] < taper["old"][edge] * 0.99
                   for edge in ["start", "end"]), taper
        print("PASS rounded subtle start/end taper keeps the body thin and dots and short accents unchanged")

        rendering = page.evaluate("""async () => {
          const object={type:'pen',inkVersion:InkEngine.profile.version,color:'#24304a',width:8,
            points:[{x:80,y:100,p:0.5},{x:100,y:110,p:0.8},{x:120,y:100,p:1.2},{x:140,y:130,p:1}]};
          const c=document.createElement('canvas');c.width=400;c.height=400;
          const context=c.getContext('2d');
          const pixels=()=>c.toDataURL();
          paintObject(context,object);const original=pixels();
          const originalPoints=JSON.stringify(object.points);
          moveObject(object,90,70);context.clearRect(0,0,400,400);
          context.save();context.translate(-90,-70);paintObject(context,object);context.restore();
          const moved=pixels();
          const saved=JSON.parse(JSON.stringify(object));context.clearRect(0,0,400,400);
          context.save();context.translate(-90,-70);paintObject(context,saved);context.restore();
          const restored=pixels();
          context.clearRect(0,0,400,400);context.save();context.scale(2,2);
          context.translate(-90,-70);paintObject(context,saved);context.restore();
          const data=context.getImageData(0,0,400,400).data;let ink=0;
          for(let i=3;i<data.length;i+=4)if(data[i])ink++;
          return {identical:original===moved&&moved===restored,changed:originalPoints!==JSON.stringify(object.points),ink};
        }""")
        assert rendering["identical"] and rendering["changed"] and rendering["ink"] > 1000, rendering
        print("PASS vector path cache invalidates on movement; reload and 2x rendering preserve ink")

        editing = page.evaluate("""() => {
          return [2,3,4,5,6,InkEngine.profile.version].map(version=>{
            clearBoardInteraction();
            objects=[{type:'pen',inkVersion:version,color:'#245bea',width:6,
              inkOptions:version>=4?InkEngine.strokeOptions({},'pen','pen'):
                {smoothing:0.4725,streamline:0,thinning:1,simulatePressure:false},
              points:Array.from({length:41},(_,i)=>({x:100+i*5,y:300,p:0.7+i/100}))}];
            chooseTool('eraser');eraserMode='stroke';
            inkEvent('pointerdown',200,280);
            inkEvent('pointermove',200,320);
            inkEvent('pointerup',200,320);
            const cut=objects.length===2&&objects.every(o=>o.inkVersion===version&&o.points.every(p=>Number.isFinite(p.p)));
            undo();const restored=objects.length===1&&objects[0].points.length===41;
            chooseTool('moveLasso');lassoMode='rectangle';
            lassoPath=[{x:140,y:270},{x:180,y:270},{x:180,y:330},{x:140,y:330}];
            completeLasso();
            const selected=groupSelection.length>0;
            chooseTool('pen');
            return {version,cut,restored,selected};
          });
        }""")
        assert all(result["cut"] and result["restored"] and result["selected"] for result in editing), editing
        print("PASS partial erasing, undo and lasso selection for previous and current ink versions")

        masks = page.evaluate("""() => {
          const object={type:'highlight',inkVersion:InkEngine.profile.version,color:'#ffb400',width:3,
            points:[{x:100,y:200,p:1},{x:180,y:200,p:1},{x:220,y:230,p:1}],
            clipRegions:[[{x:90,y:180},{x:250,y:180},{x:250,y:250},{x:90,y:250}]],
            cutouts:[[{x:160,y:180},{x:190,y:180},{x:190,y:250},{x:160,y:250}]]};
          const c=document.createElement('canvas');c.width=300;c.height=300;
          const context=c.getContext('2d');paintObject(context,object);
          return {inside:context.getImageData(130,200,1,1).data[3],
            cut:context.getImageData(175,200,1,1).data[3]};
        }""")
        assert 75 <= masks["inside"] <= 78 and masks["cut"] == 0, masks
        assert page.locator("#exportSvgBtn").count() == 0
        assert page.evaluate("typeof buildPageSVG") == "undefined"
        assert not errors, errors
        print("PASS automatic ink lasso masks and complete removal of SVG export")

        preview = os.environ.get("ST_WEB_INK_PREVIEW")
        if preview:
            page.set_viewport_size({"width": 1440, "height": 1000})
            page.evaluate("""() => {
              clearBoardInteraction();objects=[];view={x:0,y:0,z:1,fit:false};
              const text=(y,label)=>objects.push({type:'text',text:label,x:90,y,size:20,color:'#24304a'});
              text(90,'Nét viết mới · Mượt & bám đầu bút');
              for(let row=0;row<3;row++) {
                text(145+row*130,['Bút đều','Bút nhạy lực & độ nghiêng','Tô sáng · Màu đều ở chỗ nối'][row]);
                const input=InkEngine.createInput({pointerType:row===1?'pen':'mouse',scale:1,type:row===2?'highlight':'pen'});
                const points=Array.from({length:350},(_,i)=>input.sample({x:100+i*1.6,
                  y:205+row*130+23*Math.sin(i/15),time:i*8,pressure:0.5+0.4*Math.sin(i/40),tiltX:35}));
                objects.push({type:row===2?'highlight':'pen',inkVersion:InkEngine.profile.version,
                  inkOptions:InkEngine.strokeOptions({},row===1?'pen':'mouse',row===2?'highlight':'pen'),
                  color:row===2?'#ffb400':'#24304a',width:row===2?3:1.6,points});
              }
              chooseTool('pen');draw();
              if(document.body.classList.contains('sidebar-collapsed'))document.getElementById('toggleSidebar').click();
              document.querySelector('.pen-settings').open=true;
            }""")
            page.wait_for_timeout(150)
            page.screenshot(path=preview)
        browser.close()


if __name__ == "__main__":
    run()
