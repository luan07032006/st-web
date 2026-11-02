"""Apple Pencil web input and native action dispatch, with mocked HTTP and isolated IndexedDB.

Run: python tests/test_pencil_browser.py
Hardware double-tap/Swift compilation require an iPad and Xcode; this tests the JS receiver.
"""
import json
import mimetypes
import os
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run():
    with sync_playwright() as playwright:
        chrome = Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe"
        browser = playwright.chromium.launch(**({"executable_path": str(chrome)} if chrome.exists() else {}))
        page = browser.new_page(viewport={"width": 1194, "height": 834}, has_touch=True, device_scale_factor=2,
            user_agent="Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")
        page.add_init_script("sessionStorage.setItem('qh-authenticated','true')")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def serve(route):
            path = unquote(urlsplit(route.request.url).path)
            if path.startswith("/api/"):
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
        page.evaluate("PencilControls.ready")
        page.evaluate("""() => {
          canvas.setPointerCapture=()=>{};
          window.frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          window.resetPencil=()=>{
            clearBoardInteraction();objects=[];undoStack=[];redoStack=[];penSize=8;
            view={x:(boardW-paper.w)/2,y:0,z:1,fit:false,manualPan:true};chooseTool('pen');draw();
          };
          window.pencilEvent=(type,x,y,t,pressure=.5,id=91,pointerType='pen',extra={})=>{
            const r=canvas.getBoundingClientRect();
            const event=new PointerEvent(type,{bubbles:true,button:0,buttons:type==='pointerup'?0:1,
              pointerId:id,pointerType,pressure,tiltX:25,tiltY:15,
              clientX:r.left+view.x+x*view.z,clientY:r.top+view.y+y*view.z,...extra});
            Object.defineProperty(event,'timeStamp',{value:t});canvas.dispatchEvent(event);
          };
          window.pencilStroke=(force,t=1000,y=200)=>{
            pencilEvent('pointerdown',100,y,t,force);
            for(let i=1;i<=80;i++)pencilEvent('pointermove',100+i*4,y+Math.sin(i/16)*5,t+i*4,force);
            pencilEvent('pointerup',420,y+Math.sin(5)*5,t+324,0);
            return objects.at(-1);
          };
          window.renderedArea=object=>{
            const c=document.createElement('canvas');c.width=600;c.height=500;
            paintObject(c.getContext('2d'),object);
            const pixels=c.getContext('2d').getImageData(200,80,150,350).data;
            let area=0;for(let i=3;i<pixels.length;i+=4)area+=pixels[i]/255;return area;
          };
          resetPencil();
        }""")
        assert page.evaluate("PencilControls.pencilOnly && !PencilControls.nativeAvailable")
        forces = page.evaluate("""() => {
          const low=pencilStroke(.08),high=pencilStroke(.92,2000,270);
          const mean=o=>o.points.slice(20,-20).reduce((s,p)=>s+p.p,0)/(o.points.length-40);
          return {low:mean(low),high:mean(high),lowArea:renderedArea(low),highArea:renderedArea(high),
            polished:objects.every(o=>o.inkOptions.refinementVersion>=2&&o.inkOptions.pressureResponse===true),
            raw:low.rawPoints.slice(0,-1).every(p=>Math.abs(p.pressure-.08)<1e-6),
            lift:low.rawPoints.at(-1).pressure===0&&low.rawPoints.at(-1).endpoint};
        }""")
        assert forces["high"] > forces["low"] * 2 and forces["highArea"] > forces["lowArea"] * 2, forces
        assert forces["polished"] and forces["raw"] and forces["lift"], forces
        dynamics = page.evaluate("""() => {
          const a=InkEngine.createInput({pointerType:'pen',pressureResponse:true,scale:1}),
            b=InkEngine.createInput({pointerType:'pen',pressureResponse:true,scale:.5});
          let before=0,maxStep=0,scale=true;const values=[];
          for(let i=0;i<120;i++){
            const p={x:100+i*2,y:200,time:i*1000/240,pressure:i<30?.1:i<80?.9:.1};
            const x=a.sample(p),y=b.sample({...p,x:p.x*2,y:p.y*2});
            if(i)maxStep=Math.max(maxStep,Math.abs(x.p-before));before=x.p;values.push(x.p);
            scale &&= Math.abs(x.p-y.p)<1e-9;
          }
          return {scale,maxStep,low:values[20],high:values[70],released:values[115]};
        }""")
        assert dynamics["scale"] and dynamics["maxStep"] < .4 and dynamics["high"] > dynamics["low"] * 2 and dynamics["released"] < dynamics["high"] * .6, dynamics
        print("PASS pressure controls live/final ink thickness, survives smoothing, records raw force and responds smoothly at 240 Hz independent of zoom")

        assert page.evaluate("""async () => {
          resetPencil();const before=JSON.stringify(objects),z=view.z;
          pencilEvent('pointerdown',200,250,3000,.5,11,'touch');
          pencilEvent('pointermove',200,180,3008,.5,11,'touch');
          pencilEvent('pointerup',200,180,3016,0,11,'touch');await frame();
          if(JSON.stringify(objects)!==before || view.y>=0)return false;
          pencilEvent('pointerdown',200,250,3020,.5,12,'touch',{width:70,height:50});
          pencilEvent('pointermove',250,350,3028,.5,12,'touch',{width:70,height:50});
          pencilEvent('pointerup',250,350,3036,0,12,'touch');
          pencilEvent('pointerdown',120,350,3100,.3);
          pencilEvent('pointerdown',190,380,3102,.5,13,'touch');
          pencilEvent('pointermove',240,400,3104,.5,13,'touch');
          for(let i=1;i<=12;i++)pencilEvent('pointermove',120+i*5,350,3100+i*4,.6);
          pencilEvent('pointerup',180,350,3152,0);
          pencilEvent('pointerup',240,400,3154,0,13,'touch');await frame();
          return objects.length===1&&objects[0].type==='pen'&&objects[0].rawPoints.length===14
            &&!paperGesture&&!touchPointers.size&&!dragging&&view.z===z;
        }""")
        assert page.evaluate("""async () => {
          resetPencil();chooseTool('highlight');PencilControls.perform('switchEraser');
          if(tool!=='eraser')return false;PencilControls.perform('switchEraser');
          if(tool!=='highlight')return false;chooseTool('pen');
          pencilEvent('pointerdown',100,200,4000,.4);
          for(let i=1;i<=20;i++)pencilEvent('pointermove',100+i*4,200,4000+i*4,.7);
          PencilControls.perform('switchEraser');if(tool!=='pen')return false;
          pencilEvent('pointerup',180,200,4084,0);await frame();
          const kept=objects.length===1&&objects[0].type==='pen'&&tool==='eraser';
          PencilControls.perform('switchEraser');return kept&&tool==='pen';
        }""")
        print("PASS pencil-only finger navigation, palm rejection, no interrupted stroke, pen/eraser return and deferred native actions")

        page.locator("#pencilSettingsBtn").tap()
        assert page.locator("#pencilDialog").is_visible()
        page.locator('[data-pressure-curve="soft"]').click()
        soft = page.evaluate("InkEngine.createInput({pointerType:'pen',...PencilControls.inputOptions({pointerType:'pen'})}).sample({x:0,y:0,time:0,pressure:.2}).p")
        page.locator('[data-pressure-curve="firm"]').click()
        firm = page.evaluate("InkEngine.createInput({pointerType:'pen',...PencilControls.inputOptions({pointerType:'pen'})}).sample({x:0,y:0,time:0,pressure:.2}).p")
        assert soft > firm
        page.evaluate("""() => {
          const p=$('pencilTestPad');p.setPointerCapture=()=>{};const r=p.getBoundingClientRect();
          for(let i=0;i<32;i++)p.dispatchEvent(new PointerEvent(i===0?'pointerdown':i===31?'pointerup':'pointermove',{
            pointerType:'pen',pointerId:60,buttons:i===31?0:1,pressure:i===31?0:.15+i*.025,
            clientX:r.left+20+i*7,clientY:r.top+70+Math.sin(i/5)*20}));
        }""")
        page.wait_for_function("Number(document.querySelector('#pencilForce').value.replace('%',''))>80")
        shots = Path(tempfile.gettempdir()) / "bangtrang-pencil-qa"
        shots.mkdir(exist_ok=True)
        page.screenshot(path=str(shots / "pencil-settings.png"))
        for width, height, theme in [(834, 1194, "light"), (375, 812, "light"), (1194, 834, "dark")]:
            page.set_viewport_size({"width": width, "height": height})
            page.evaluate("applyTheme('" + theme + "')")
            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
            assert page.locator("#closePencil").bounding_box()["width"] >= 44
            page.screenshot(path=str(shots / f"pencil-{width}-{theme}.png"))
        page.locator("#pencilOnly").uncheck()
        page.wait_for_function("document.querySelector('#pencilSettingsStatus').textContent.includes('Đã lưu')")
        page.locator("#closePencil").click()
        expected = page.evaluate("JSON.stringify(objects)")
        page.evaluate("documentWorkspace.flush()")
        page.reload()
        page.evaluate("documentReady")
        page.evaluate("PencilControls.ready")
        assert page.evaluate("JSON.stringify(objects)") == expected
        assert page.evaluate("!PencilControls.pencilOnly && PencilControls.inputOptions({pointerType:'pen'}).pressureExponent===1.3")
        assert page.evaluate("async ()=>(await exportLessonPDF()).size>1000")
        page.evaluate("PencilControls.perform('palette')")
        assert page.locator("#pencilPalette").is_visible()
        page.locator('[data-pencil-color="#e65967"]').click()
        assert page.evaluate("color") == "#e65967"
        assert not page.locator("#pencilPalette").is_visible()
        assert not errors, errors
        print("PASS sensitivity settings, test pad, iPad/phone/dark layouts, quick colors, settings persistence, force-preserving reload and PDF")
        print(f"Screenshots: {shots}")
        browser.close()


if __name__ == "__main__":
    run()
