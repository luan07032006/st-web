"""Run: python tests/test_rounded_handwriting_browser.py.

Rounded handwriting, mathematical shapes and editing integration in real Chrome.
HTTP and lesson writes are mocked; the user's saved board is never modified.
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
        page.add_init_script("sessionStorage.setItem('qh-authenticated','true')")

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
        page.wait_for_function("typeof RoundedInk !== 'undefined' && boardW > 0")
        page.evaluate("""() => {
          canvas.setPointerCapture=()=>{};
          window.letterPath=(knots,step=.5)=>RoundedInk.resample(knots.map(([x,y])=>({x,y,p:1})),step);
          window.letterPixels=object=>{
            const c=document.createElement('canvas');c.width=600;c.height=500;
            paintObject(c.getContext('2d'),object);return c.toDataURL();
          };
          window.refine=points=>beautifyStroke(points,{scale:1,type:'pen'});
          window.cursiveL=()=>{
            const points=letterPath([[31,29],[28,26],[28,22],[29,19],[32,17],[35,14],[38,13],[40,15],
              [41,21],[40,28],[38,36],[34,43],[29,49],[22,54],[17,55],[14,52],[13,46],[14,41],
              [17,40],[20,41],[24,46],[29,52],[35,57],[42,61],[49,61],[55,59]],.4);
            return points.map((p,i)=>({...p,x:p.x+(!i||i===points.length-1?0:.5*Math.sin(i/2.1)),
              y:p.y+(!i||i===points.length-1?0:.4*Math.sin(i/2.5)),p:.7+.5*Math.sin(i/3)}));
          };
          window.letterMetrics=points=>{
            const sampled=RoundedInk.resample(points,.6),turns=[];
            for(let i=1;i<sampled.length-1;i++){
              const a=sampled[i-1],b=sampled[i],c=sampled[i+1];
              const dx=b.x-a.x,dy=b.y-a.y,ex=c.x-b.x,ey=c.y-b.y;
              if(Math.hypot(dx,dy)>.01&&Math.hypot(ex,ey)>.01)
                turns.push(Math.acos(Math.max(-1,Math.min(1,(dx*ex+dy*ey)/(Math.hypot(dx,dy)*Math.hypot(ex,ey))))));
            }
            return {peak:Math.max(0,...turns),variation:turns.reduce((a,b)=>a+b,0),box:rawBounds({points}),
              finite:points.every(p=>['x','y','p'].every(k=>Number.isFinite(p[k])))};
          };
          clearBoardInteraction();objects=[];view={x:0,y:0,z:1,fit:false};draw();
        }""")

        corners = page.evaluate("""() => {
          const cases=[[[80,120],[110,170],[140,120]],
            [[80,120],[80,160],[90,170],[105,170],[115,160],[115,120]],
            [[80,170],[80,130],[90,120],[105,120],[115,130],[115,170]],
            [[80,120],[80,160],[85,170],[100,170],[110,160]]];
          return cases.map(knots=>{
            const source=letterPath(knots),result=refine(source),before=letterMetrics(source),after=letterMetrics(result);
            return {before,after,count:result.length,first:result[0],last:result.at(-1),
              expectedFirst:source[0],expectedLast:source.at(-1),
              drift:Math.max(...result.map(p=>Math.min(...source.map(q=>Math.hypot(p.x-q.x,p.y-q.y)))))};
          });
        }""")
        for result in corners:
            assert result["after"]["peak"] < result["before"]["peak"] * 0.45, result
            assert result["after"]["finite"] and result["count"] > 25, result
            assert [result["first"][k] for k in ["x", "y"]] == [result["expectedFirst"][k] for k in ["x", "y"]], result
            assert [result["last"][k] for k in ["x", "y"]] == [result["expectedLast"][k] for k in ["x", "y"]], result
            assert 0.6 < result["drift"] < 6.5, result
            assert result["after"]["box"]["h"] > result["before"]["box"]["h"] * .85, result
        print("PASS visibly rounded V/u/n/hooks with smooth joins, fixed endpoints and bounded shape change")

        details = page.evaluate("""() => {
          const arch=Array.from({length:81},(_,i)=>({x:60+i,y:100-6*Math.sin(i*Math.PI/80),p:1}));
          const fitted=refine(arch);
          const narrow=letterPath([[80,120],[80,140],[82,142],[84,140],[84,120]]),u=refine(narrow);
          const dot=[{x:50,y:50,p:1}],accent=letterPath([[60,60],[62,58]],.4);
          const line=refine(Array.from({length:101},(_,i)=>({x:80+i,y:200+.4*Math.sin(i/3),p:1})));
          const rectangle=refine(letterPath([[200,200],[260,200],[260,240],[200,240],[200,200]]));
          const sampledV=count=>Array.from({length:count*2+1},(_,i)=>{
            const t=i/count;return{x:80+t*30,y:t<=1?120+t*50:170-(t-1)*50,p:1};
          });
          const a=sampledV(240),b=sampledV(60);
          const fitA=RoundedInk.resample(refine(a),.5),fitB=RoundedInk.resample(refine(b),.5);
          const scaled=beautifyStroke(a.map(p=>({...p,x:p.x*2,y:p.y*2})),{scale:.5,type:'pen'}),normal=refine(a);
          return {archHeight:100-Math.min(...fitted.map(p=>p.y)),narrowOpen:Math.hypot(u[0].x-u.at(-1).x,u[0].y-u.at(-1).y)>3.9,
            dots:JSON.stringify(refine(dot))===JSON.stringify(dot)&&JSON.stringify(refine(accent))===JSON.stringify(accent),
            line:line.length===2,rectangle:rectangle.every(p=>Math.min(Math.abs(p.x-200),Math.abs(p.x-260),Math.abs(p.y-200),Math.abs(p.y-240))<1e-6),
            density:fitA.length===fitB.length&&fitA.every((p,i)=>Math.hypot(p.x-fitB[i].x,p.y-fitB[i].y)<.1),
            scale:scaled.length===normal.length&&normal.every((p,i)=>Math.hypot(p.x-scaled[i].x/2,p.y-scaled[i].y/2)<1e-6)};
        }""")
        assert details["archHeight"] > 4.5 and all(details[k] for k in ["narrowOpen", "dots", "line", "rectangle", "density", "scale"]), details
        print("PASS shallow arches and narrow U openings, diacritics, straight lines/rectangles and sampling/zoom independence")

        loops = page.evaluate("""() => [-1,1].flatMap(direction=>[3,6,16].map(radius=>{
          const source=Array.from({length:121},(_,i)=>{
            const t=direction*i*Math.PI/60,r=radius*(1+.035*Math.sin(i*Math.PI/6));
            return {x:120+r*Math.cos(t),y:120+r*Math.sin(t),p:1};
          });
          const result=refine(source),m=letterMetrics(result),box=m.box,cx=box.x+box.w/2,cy=box.y+box.h/2;
          const radial=result.map(p=>Math.hypot((p.x-cx)/(box.w/2),(p.y-cy)/(box.h/2)));
          const winding=result.reduce((sum,p,i)=>{const q=result[(i+1)%result.length];return sum+p.x*q.y-q.x*p.y},0);
          const c=document.createElement('canvas');c.width=250;c.height=250;const context=c.getContext('2d');
          paintObject(context,{type:'pen',color:'#24304a',width:1.6,inkVersion:11,inkOptions:{closed:true,refinementVersion:2},points:result});
          return {radius,count:result.length,radialError:Math.max(...radial.map(r=>Math.abs(r-1))),winding:Math.sign(winding)===direction,
            hole:context.getImageData(120,120,1,1).data[3]===0,width:box.w,height:box.h,finite:m.finite};
        }))""")
        for loop in loops:
            assert loop["count"] >= 65 and loop["radialError"] < .003 and loop["winding"] and loop["hole"] and loop["finite"], loop
            assert loop["width"] > loop["radius"] * 1.9 and loop["height"] > loop["radius"] * 1.9, loop
        print("PASS small/large O's are round rather than polygons, with open centers and preserved winding")

        figure_eight = page.evaluate("""() => {
          const source=Array.from({length:241},(_,i)=>({x:150+14*Math.sin(i*Math.PI/120),y:150+22*Math.sin(i*Math.PI/60),p:1}));
          const points=refine(source),box=rawBounds({points});
          const a=points[0],b=points[1],c=points.at(-2),d=points.at(-1);
          const tangent=((b.x-a.x)*(d.x-c.x)+(b.y-a.y)*(d.y-c.y))/(Math.hypot(b.x-a.x,b.y-a.y)*Math.hypot(d.x-c.x,d.y-c.y));
          return {width:box.w,height:box.h,tangent,closed:Math.hypot(a.x-d.x,a.y-d.y)<1e-8,
            intersection:Math.min(...points.map(p=>Math.hypot(p.x-150,p.y-150)))<1,
            finite:points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))};
        }""")
        assert figure_eight["width"] > 24 and figure_eight["height"] > 37 and figure_eight["tangent"] > .995, figure_eight
        assert all(figure_eight[k] for k in ["closed", "intersection", "finite"]), figure_eight
        print("PASS closed multi-loop handwriting keeps both lobes, its crossing and a continuous closure tangent")

        polished = page.evaluate("""() => {
          const points=cursiveL(),fitted=RoundedInk.smooth(points);
          const roughness=path=>{
            const q=RoundedInk.resample(path,.8),angles=[];
            for(let i=1;i<q.length-1;i++){
              const a=q[i-1],b=q[i],c=q[i+1];
              angles.push(Math.atan2((b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x),
                (b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y)));
            }
            return angles.slice(1).reduce((sum,a,i)=>sum+Math.abs(a-angles[i]),0);
          };
          const c=document.createElement('canvas');c.width=80;c.height=80;const context=c.getContext('2d');
          paintObject(context,{type:'pen',width:1.6,color:'#24304a',inkVersion:11,inkOptions:{refinementVersion:2},points:fitted});
          return {before:roughness(points),after:roughness(fitted),range:Math.max(...fitted.map(p=>p.p))-Math.min(...fitted.map(p=>p.p)),
            upperHole:context.getImageData(35,25,1,1).data[3],lowerHole:context.getImageData(17,47,1,1).data[3],
            first:Math.hypot(points[0].x-fitted[0].x,points[0].y-fitted[0].y),
            last:Math.hypot(points.at(-1).x-fitted.at(-1).x,points.at(-1).y-fitted.at(-1).y)};
        }""")
        assert polished["after"] < polished["before"] * .25 and polished["range"] < .2, polished
        assert polished["first"] == 0 and polished["last"] == 0, polished
        assert polished["upperHole"] == 0 and polished["lowerHole"] == 0, polished
        print("PASS cursive L loses curvature/width ripples while retaining its upper/lower openings and endpoints")

        fidelity = page.evaluate("""() => {
          const tilted=Array.from({length:241},(_,i)=>{
            const t=i*2*Math.PI/240,y=24*Math.sin(t);
            return{x:120+12*Math.cos(t)+.45*y,y:140+y,p:1};
          });
          const cases=[{name:'cursive L',source:cursiveL(),closed:false},
            {name:'slanted oval',source:tilted,closed:true},
            {name:'small loop',source:tilted.map(p=>({...p,x:100+(p.x-120)/4,y:100+(p.y-140)/4})),closed:true},
            {name:'narrow U',source:letterPath([[80,120],[80,140],[82,142],[84,140],[84,120]]),closed:false},
            {name:'V',source:letterPath([[80,120],[110,170],[140,120]]),closed:false}];
          const principal=points=>{
            const n=points.length,mx=points.reduce((s,p)=>s+p.x,0)/n,my=points.reduce((s,p)=>s+p.y,0)/n;
            let xx=0,yy=0,xy=0;for(const p of points){xx+=(p.x-mx)**2;yy+=(p.y-my)**2;xy+=(p.x-mx)*(p.y-my);}
            return Math.atan2(2*xy,xx-yy)/2;
          };
          return cases.map(({name,source,closed})=>{
            const fit=RoundedInk.smooth(source,{closed}),a=rawBounds({points:source}),b=rawBounds({points:fit});
            const sampled=RoundedInk.resample(closed?source.slice(0,-1):source,.5,closed),lengths=[0];
            for(let i=1;i<sampled.length;i++)lengths.push(lengths.at(-1)+Math.hypot(sampled[i].x-sampled[i-1].x,sampled[i].y-sampled[i-1].y));
            const total=lengths.at(-1)+(closed?Math.hypot(sampled.at(-1).x-sampled[0].x,sampled.at(-1).y-sampled[0].y):0);
            const error=Math.max(...sampled.map((p,i)=>{
              const position=lengths[i]/total*(fit.length-1),j=Math.min(fit.length-2,Math.floor(position)),t=position-j;
              return Math.hypot(p.x-fit[j].x-(fit[j+1].x-fit[j].x)*t,p.y-fit[j].y-(fit[j+1].y-fit[j].y)*t);
            }));
            return {name,error,width:Math.abs(a.w-b.w),height:Math.abs(a.h-b.h),
              left:Math.abs(a.x-b.x),top:Math.abs(a.y-b.y),
              tilt:Math.abs(principal(RoundedInk.resample(source,.4))-principal(RoundedInk.resample(fit,.4))),
              first:Math.hypot(source[0].x-fit[0].x,source[0].y-fit[0].y),
              last:closed?Math.hypot(fit[0].x-fit.at(-1).x,fit[0].y-fit.at(-1).y):Math.hypot(source.at(-1).x-fit.at(-1).x,source.at(-1).y-fit.at(-1).y)};
          });
        }""")
        for result in fidelity:
            assert result["error"] <= 2.05, result
            assert max(result[k] for k in ["width", "height", "left", "top"]) < .4, result
            assert result["first"] < 1e-8 and result["last"] < 1e-8, result
            if result["name"] == "slanted oval":
                assert result["tilt"] < .025, result
        print("PASS original letter proportions, slant, endpoints and small openings survive smoothing with bounded displacement")

        opening = page.evaluate("""() => {
          const source=Array.from({length:241},(_,i)=>{
            const t=.02+i*(2*Math.PI-.04)/240;
            return{x:120+18*Math.cos(t)+5*Math.sin(t),y:140+22*Math.sin(t),p:1,rawIndex:i,t:i*4};
          });
          // Live position filtering may bring the tail closer to the start.
          // Closure must follow the actual down/up coordinates, not that lag.
          const points=source.map(p=>({...p}));points.at(-1).y=points[0].y-.1;
          const object={type:'pen',inkVersion:11,width:1.6,color:'#24304a',points,
            rawPoints:source.map(p=>({x:p.x,y:p.y,t:p.t,pressure:.6,tiltX:0,tiltY:0}))};
          refineCompletedInk(object);
          const manual=beautifyStroke(source,{scale:1,type:'pen',preserveForm:true});
          return {automaticOpen:object.inkOptions.closed===false,
            manualOpen:Math.hypot(manual[0].x-manual.at(-1).x,manual[0].y-manual.at(-1).y)>.8,
            manualEnds:manual[0].x===source[0].x&&manual[0].y===source[0].y&&manual.at(-1).x===source.at(-1).x&&manual.at(-1).y===source.at(-1).y};
        }""")
        assert all(opening.values()), opening
        print("PASS near-closed letters retain their written opening through both automatic and manual refinement")

        automatic = page.evaluate("""() => ['pen','mouse','touch'].map((pointerType,run)=>{
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];chooseTool('pen');draw();
          const source=cursiveL().map(p=>({...p,x:p.x+100,y:p.y+200}));
          const original=RoundedInk.smooth;let fits=0;
          RoundedInk.smooth=(...args)=>{fits++;return original(...args)};
          const fire=(type,point,i)=>{
            const r=canvas.getBoundingClientRect();
            const event=new PointerEvent(type,{pointerType,pointerId:27,button:0,
              buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:.6,tiltX:25,tiltY:10,
              clientX:r.left+view.x+point.x*view.z,clientY:r.top+view.y+point.y*view.z});
            Object.defineProperty(event,'timeStamp',{value:10000+run*10000+i*4});canvas.dispatchEvent(event);
          };
          fire('pointerdown',source[0],0);
          source.slice(1).forEach((p,i)=>fire('pointermove',p,i+1));
          const live=JSON.stringify(active.points),raw=JSON.stringify(active.rawPoints),during=fits;
          const first={...active.points[0]},last={...active.points.at(-1)};
          fire('pointerup',source.at(-1),source.length);RoundedInk.smooth=original;
          const object=objects[0],after=JSON.stringify(object),pixels=letterPixels(object);
          const metadata=object.points.every((p,i)=>Number.isInteger(p.rawIndex)&&p.rawIndex<object.rawPoints.length
            &&p.t===object.rawPoints[p.rawIndex].t&&(!i||p.rawIndex>=object.points[i-1].rawIndex));
          const actualRaw=object.rawPoints.slice(0,-1);
          const stableRaw=JSON.stringify(actualRaw)===raw&&object.rawPoints.at(-1).pressure===0;
          const endpoints=first.x===object.points[0].x&&first.y===object.points[0].y
            &&last.x===object.points.at(-1).x&&last.y===object.points.at(-1).y;
          undo();const removed=objects.length===0;redo();
          return {pointerType,during,fits,metadata,stableRaw,endpoints,removed,
            auto:object.inkOptions.refinementVersion===3&&live!==JSON.stringify(object.points),
            undo:JSON.stringify(objects[0])===after&&letterPixels(objects[0])===pixels};
        })""")
        for result in automatic:
            assert result["during"] == 0 and result["fits"] == 1, result
            assert all(result[k] for k in ["metadata", "stableRaw", "endpoints", "removed", "auto", "undo"]), result
        assert not errors, errors
        print("PASS pen/mouse/touch automatically polish exactly once on lift, with responsive live input and intact raw/undo data")

        integration = page.evaluate("""() => {
          clearBoardInteraction();objects=[];undoStack=[];redoStack=[];view={x:0,y:0,z:1,fit:false};draw();
          const points=letterPath([[100,200],[100,240],[110,250],[125,250],[135,240],[135,200]]);
          const rawPoints=points.map((p,i)=>({x:p.x,y:p.y,pressure:.4+.2*Math.sin(i/20),tiltX:25,tiltY:10,t:1000+i*4}));
          const object={type:'pen',width:2.4,color:'#24304a',inkVersion:10,rawPoints,
            points:points.map((p,i)=>({...p,p:.7+.4*Math.sin(i/20),...rawPoints[i],rawIndex:i}))};
          const other={type:'text',x:300,y:200,text:'Giữ nguyên',size:20,color:'#24304a'};
          objects=[object,other];const before=JSON.stringify(objects),raw=JSON.stringify(rawPoints),otherBefore=JSON.stringify(other);
          selection={x:80,y:180,w:80,h:90};beautifySelection();
          const after=JSON.stringify(objects),fitted=objects[0],pixels=letterPixels(fitted);
          const metadata=fitted.points.every((p,i)=>p.t===fitted.rawPoints[p.rawIndex].t&&p.tiltX===25&&p.tiltY===10
            &&(!i||p.rawIndex>=fitted.points[i-1].rawIndex));
          const legacy=fitted.inkVersion===11&&fitted.inkOptions.beautified===true;
          const pressure=Math.max(...fitted.points.map(p=>p.p))-Math.min(...fitted.points.map(p=>p.p));
          undo();const undoFixed=JSON.stringify(objects)===before;
          redo();const redoFixed=JSON.stringify(objects)===after&&letterPixels(objects[0])===pixels;
          const doc=validateDoc(JSON.parse(JSON.stringify(lessonData())));applyDoc(doc);
          const reload=JSON.stringify(objects)===after&&letterPixels(objects[0])===pixels;
          saveLesson();
          return {metadata,legacy,pressure,undoFixed,redoFixed,reload,raw:JSON.stringify(objects[0].rawPoints)===raw,
            unselected:JSON.stringify(objects[1])===otherBefore,changed:before!==after,saved:JSON.parse(after)};
        }""")
        assert all(integration[k] for k in ["metadata", "legacy", "undoFixed", "redoFixed", "reload", "raw", "unselected", "changed"]), integration
        page.evaluate("saveLesson()")
        page.evaluate("DocumentStore.sync(documentWorkspace.activeId)")
        assert .05 < integration["pressure"] < .65, integration
        page.wait_for_function("document.getElementById('saveStatus').textContent.includes('Đã lưu')")
        assert saves[-1]["objects"] == integration["saved"], saves[-1]
        assert not errors, errors
        print("PASS selected legacy handwriting upgrades cleanly, pressure/tilt/raw history, save/reload and exact undo/redo")

        erasing = page.evaluate("""() => {
          const before=JSON.stringify(objects);chooseTool('eraser');eraserMode='stroke';
          const fire=(type,x,y)=>{
            const r=canvas.getBoundingClientRect();canvas.dispatchEvent(new PointerEvent(type,{pointerId:27,pointerType:'pen',
              button:0,buttons:type==='pointerup'?0:1,pressure:.5,clientX:r.left+view.x+x*view.z,clientY:r.top+view.y+y*view.z}));
          };
          fire('pointerdown',117,235);fire('pointermove',117,265);fire('pointerup',117,265);
          const pieces=objects.filter(o=>o.type==='pen');
          const linked=pieces.every(piece=>piece.points.every((p,i)=>Number.isInteger(p.rawIndex)&&p.rawIndex>=0
            &&p.rawIndex<piece.rawPoints.length&&p.t===piece.rawPoints[p.rawIndex].t&&(!i||p.rawIndex>=piece.points[i-1].rawIndex)));
          const drawable=pieces.every(piece=>typeof letterPixels(piece)==='string');
          const split=pieces.length===2;undo();const undoFixed=before===JSON.stringify(objects);
          const moved=objects[0];
          const reference=document.createElement('canvas');reference.width=600;reference.height=500;
          const referenceContext=reference.getContext('2d');paintObject(referenceContext,moved);
          const expected=referenceContext.getImageData(0,0,600,500).data;moveObject(moved,30,20);
          const c=document.createElement('canvas');c.width=600;c.height=500;const context=c.getContext('2d');
          context.translate(-30,-20);paintObject(context,moved);
          const actual=context.getImageData(0,0,600,500).data;let maxDelta=0;
          for(let i=3;i<actual.length;i+=4)maxDelta=Math.max(maxDelta,Math.abs(actual[i]-expected[i]));
          return {split,linked,drawable,undoFixed,move:maxDelta<=1,maxDelta};
        }""")
        assert all(erasing[k] for k in ["split", "linked", "drawable", "undoFixed", "move"]), erasing
        assert not errors, errors
        print("PASS partial erasing and movement of fitted ink retain vector shape, raw links and exact undo")

        cut_loop = page.evaluate("""() => {
          const points=RoundedInk.smooth(Array.from({length:121},(_,i)=>({x:100+20*Math.cos(i*Math.PI/60),y:100+20*Math.sin(i*Math.PI/60),p:1})),{closed:true});
          const ring={type:'pen',inkVersion:11,width:2,color:'#24304a',inkOptions:{closed:true,refinementVersion:2},points};
          const fragment=inkFragment(ring,points.slice(20,Math.floor(points.length*.65)));
          const c=document.createElement('canvas');c.width=200;c.height=200;const context=c.getContext('2d');paintObject(context,fragment);
          const center=context.getImageData(100,100,1,1).data[3];
          return {open:fragment.inkOptions.closed===false,center};
        }""")
        assert cut_loop["open"] and cut_loop["center"] == 0, cut_loop
        print("PASS erasing a fitted loop creates open fragments without a closing chord")

        preview = os.environ.get("ST_WEB_ROUNDED_PREVIEW")
        if preview:
            page.evaluate("""() => {
              const report=document.createElement('div');report.id='roundPreview';
              report.style='position:fixed;inset:0;background:#f3f5f9;padding:42px;z-index:99999;font-family:Segoe UI;color:#24304a';
              report.innerHTML='<h1 style="font-size:28px;margin:0 0 10px">Nắn mượt, giữ đúng dáng chữ</h1><p style="margin:0 0 24px;color:#65718a">Giữ tỷ lệ · Giữ độ nghiêng · Giữ vòng và nét mở · Mực đều</p><canvas id="comparison" width="1280" height="690" style="width:1280px;height:690px;background:white;border-radius:18px"></canvas>';
              document.body.append(report);
              const c=document.getElementById('comparison').getContext('2d');
              c.fillStyle='#74809a';c.font='600 18px Segoe UI';c.fillText('NÉT GỐC',55,48);c.fillText('SAU KHI NẮN',695,48);
              c.strokeStyle='#eef1f6';c.lineWidth=1;for(let y=80;y<690;y+=28){c.beginPath();c.moveTo(30,y);c.lineTo(1250,y);c.stroke();}
              const glyphs=[letterPath([[65,115],[65,165],[80,184],[105,183],[120,165],[120,115]]),
                letterPath([[155,185],[155,135],[173,115],[195,115],[212,135],[212,185]]),
                Array.from({length:121},(_,i)=>{const t=i*Math.PI/60,r=32+1.4*Math.sin(i*Math.PI/6);return{x:275+r*Math.cos(t),y:150+r*Math.sin(t),p:1}}),
                letterPath([[330,115],[360,183],[390,115]]),
                letterPath([[430,115],[430,165],[440,183],[460,183],[475,165]])];
              const noisy=Array.from({length:241},(_,i)=>({x:65+i*1.7,y:340-42*Math.sin(i*Math.PI/60)+(i%2?1.2:-1.2),p:1}));
              const narrow=letterPath([[65,460],[65,510],[73,522],[85,510],[85,460]]);
              const loop=Array.from({length:161},(_,i)=>({x:205+32*Math.sin(i*Math.PI/80),y:490+42*Math.sin(i*Math.PI/40),p:1}));
              for(const source of [...glyphs,noisy,narrow,loop]){
                paintObject(c,{type:'pen',color:'#24304a',width:3.5,inkVersion:11,points:source});
                c.save();c.translate(640,0);const points=beautifyStroke(source,{scale:1,type:'pen',preserveForm:true});
                paintObject(c,{type:'pen',color:'#245bea',width:3.5,inkVersion:11,inkOptions:{refinementVersion:2,closed:Math.hypot(points[0].x-points.at(-1).x,points[0].y-points.at(-1).y)<1e-5},points});c.restore();
              }
              for(const [column,x] of [[0,350],[1,990]]){
                c.save();c.translate(x,430);c.scale(2.8,2.8);
                const source=cursiveL(),points=column?RoundedInk.smooth(source):source;
                paintObject(c,{type:'pen',color:column?'#245bea':'#24304a',width:1.6,inkVersion:11,
                  inkOptions:column?{refinementVersion:2}:{},points});c.restore();
              }
            }""")
            page.locator("#roundPreview").screenshot(path=preview)
        browser.close()


if __name__ == "__main__":
    run()
