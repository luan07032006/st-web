"""Tablet layout, independent documents and real pointer gestures; all HTTP is mocked.

Run: python tests/test_tablet_workspace_browser.py
Screenshots are written to the system temporary directory, never to lesson data.
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
        page = browser.new_page(viewport={"width": 1194, "height": 834}, device_scale_factor=2, has_touch=True)
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
        page.wait_for_function("typeof boardW!=='undefined' && boardW>0 && document.querySelector('#historySlot #undoBtn')")
        page.evaluate("""() => {
          canvas.setPointerCapture=()=>{};
          window.frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          window.pointer=(type,id,x,y,pointerType='touch')=>{
            const rect=canvas.getBoundingClientRect();
            canvas.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType,button:0,
              buttons:type==='pointerup'?0:1,clientX:rect.left+x,clientY:rect.top+y,pressure:.6,bubbles:true}));
          };
          window.write=(x,y,id=70)=>{
            chooseTool('pen');pointer('pointerdown',id,x,y,'pen');
            for(let i=1;i<=12;i++)pointer('pointermove',id,x+i*3,y+Math.sin(i/3)*16,'pen');
            pointer('pointerup',id,x+36,y+Math.sin(4)*16,'pen');
          };
        }""")
        shots = Path(tempfile.gettempdir()) / "bangtrang-tablet-qa"
        shots.mkdir(exist_ok=True)

        def layout(width, height, label):
            page.set_viewport_size({"width": width, "height": height})
            page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
            result = page.evaluate("""() => {
              const board=canvas.getBoundingClientRect();
              const tools=[...document.querySelectorAll('#toolbar button')];
              const headerButtons=[...document.querySelectorAll('.header-actions button')];
              const invalid=tools.filter(b=>{const r=b.getBoundingClientRect();return r.x<0||r.right>innerWidth+.5||r.bottom>board.top+.5||r.width<43.5||r.height<43.5});
              return {invalid:invalid.map(b=>b.id||b.dataset.tool),scroll:document.documentElement.scrollWidth>innerWidth,
                height:board.height,fill:Math.abs(board.bottom-innerHeight)<1,
                headerFits:headerButtons.every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.x>=0&&r.right<=innerWidth+.5}),
                icons:tools.every(b=>b.querySelector('svg')),
                headerIcons:[...document.querySelectorAll('.header-actions [data-icon]')].every(icon=>{
                  const button=icon.closest('button');return button.getBoundingClientRect().width===0||icon.getBoundingClientRect().width>0;
                })};
            }""")
            assert not result["invalid"] and not result["scroll"] and result["fill"] and result["icons"] and result["headerIcons"] and result["headerFits"], (label, result)
            assert result["height"] > (170 if width < 500 else 350), (label, result)
            page.screenshot(path=str(shots / f"{label}.png"))

        layout(1194, 834, "notebook-landscape")
        layout(834, 1194, "notebook-portrait")
        layout(768, 1024, "notebook-ipad-mini")
        layout(375, 812, "notebook-phone")
        page.set_viewport_size({"width": 1194, "height": 834})
        page.evaluate("frame()")
        page.locator("#shapesBtn").click()
        assert page.locator("#shapesDialog").is_visible()
        page.locator('#shapesContent [data-tool="circle"]').click()
        assert not page.locator("#shapesDialog").is_visible()
        assert page.evaluate("tool") == "circle"
        page.locator("#toggleSidebar").click()
        assert page.locator("#sidebar").is_visible()
        assert page.evaluate("boardW") == 1194
        page.locator("#closeSidebar").click()
        assert not page.locator("#sidebar").is_visible()
        page.locator("#formulaQuickBtn").click()
        assert page.locator("#textDialog").is_visible()
        page.keyboard.press("Escape")
        print("PASS all top tools and SVG icons fit iPad landscape/portrait, mini and phone; dialogs/drawer work")

        page.evaluate("""async () => {
          write(view.x+180*view.z,view.y+220*view.z);await frame();
          $('lessonName').value='Sổ của tôi';
          window.notebookInk=JSON.stringify(objects);
        }""")
        page.evaluate("setWorkspaceMode('whiteboard')")
        assert page.evaluate("objects.length===0 && workspaceMode==='whiteboard' && visiblePages()[0].infinite")
        assert not page.locator("#addPageBtn").is_visible()
        # Write outside all A4 bounds, including negative world coordinates.
        page.evaluate("""async () => {
          view={x:450,y:300,z:1,fit:false,manualPan:true};draw();
          write(80,100);await frame();$('lessonName').value='Ý tưởng của tôi';
          window.boardInk=JSON.stringify(objects);window.boardView=JSON.stringify(view);
        }""")
        assert page.evaluate("objects[0].points.every(p=>p.x<0 && p.y<0)")
        page.evaluate("setWorkspaceMode('notebook')")
        assert page.evaluate("JSON.stringify(objects)===notebookInk && $('lessonName').value==='Sổ của tôi'")
        page.evaluate("setWorkspaceMode('whiteboard')")
        assert page.evaluate("JSON.stringify(objects)===boardInk && JSON.stringify(view)===boardView && $('lessonName').value==='Ý tưởng của tôi'")
        page.evaluate("undo()")
        assert page.evaluate("objects.length===0")
        page.evaluate("redo()")
        assert page.evaluate("JSON.stringify(objects)===boardInk")
        print("PASS independent notebook/whiteboard titles, ink, views and undo/redo; unlimited board accepts negative coordinates")

        gesture = page.evaluate("""async () => {
          const before=JSON.stringify(objects),scale=view.z,anchor=world({x:500,y:300});
          pointer('pointerdown',1,400,300);pointer('pointerdown',2,600,300);
          pointer('pointermove',1,350,330);pointer('pointermove',2,650,330);await frame();
          const after=world({x:500,y:330});
          const stable=Math.hypot(anchor.x-after.x,anchor.y-after.y)<.001;
          const zoom=view.z/scale;
          pointer('pointerup',1,350,330);pointer('pointermove',2,700,350);pointer('pointerup',2,700,350);await frame();
          return {stable,zoom,noInk:JSON.stringify(objects)===before,clean:!paperGesture&&!touchPointers.size&&!dragging};
        }""")
        assert gesture == {"stable": True, "zoom": 1.5, "noInk": True, "clean": True}, gesture
        assert page.evaluate("""async () => {
          const before=JSON.stringify(objects),history=undoStack.length;
          const point=objects[0].points[4];const x=point.x*view.z+view.x,y=point.y*view.z+view.y;
          chooseTool('eraser');pointer('pointerdown',8,x,y);pointer('pointerdown',9,x+160,y);
          pointer('pointermove',9,x+200,y+20);pointer('pointerup',8,x,y);pointer('pointerup',9,x+200,y+20);await frame();
          const clean=JSON.stringify(objects)===before && undoStack.length===history;
          chooseTool('text');pointer('pointerdown',10,300,200);pointer('pointerdown',11,500,200);
          pointer('pointerup',10,300,200);pointer('pointerup',11,500,200);await frame();
          const noDialog=!$('textDialog').open;
          pointer('pointerdown',12,300,200);pointer('pointerup',12,300,200);
          const tap=$('textDialog').open;$('textDialog').close();chooseTool('pen');
          return clean && noDialog && tap;
        }""")
        page.evaluate("""async () => {
          const saved=JSON.stringify(objects);window.expectedInk=saved;
          const initial=view.z;
          canvas.dispatchEvent(new WheelEvent('wheel',{clientX:400,clientY:400,deltaY:-25,ctrlKey:true,cancelable:true}));
          await frame();if(view.z<=initial)throw Error('trackpad zoom failed');
          setBoardZoom(100);await frame();if(view.z!==4)throw Error('maximum zoom failed');
          setBoardZoom(.001);await frame();if(view.z!==.1)throw Error('minimum zoom failed');
          $('fitViewBtn').click();await frame();
          if(JSON.stringify(objects)!==saved)throw Error('zoom changed handwriting');
        }""")
        layout(1194, 834, "whiteboard-landscape")
        page.evaluate("applyTheme('dark')")
        layout(1194, 834, "whiteboard-dark")
        page.evaluate("setWorkspaceMode('notebook')")
        layout(1194, 834, "notebook-dark")
        page.evaluate("applyTheme('light')")
        # A notebook pinch must also preserve its midpoint, without moving/reshaping stored strokes.
        assert page.evaluate("""async () => {
          const ink=JSON.stringify(objects),anchor=world({x:500,y:300}),scale=view.z;
          pointer('pointerdown',3,400,300);pointer('pointerdown',4,600,300);
          pointer('pointermove',3,350,320);pointer('pointermove',4,650,320);await frame();
          const p=world({x:500,y:320});const okay=Math.hypot(p.x-anchor.x,p.y-anchor.y)<.001 && Math.abs(view.z/scale-1.5)<.001;
          pointer('pointerup',3,350,320);pointer('pointerup',4,650,320);await frame();
          return okay && JSON.stringify(objects)===ink;
        }""")
        print("PASS pinch zoom anchors both modes, two-finger panning creates no ink, trackpad zoom and 10–400% limits")

        page.evaluate("setWorkspaceMode('whiteboard')")
        page.evaluate("saveLesson()")
        page.evaluate("DocumentStore.sync(documentWorkspace.activeId)")
        page.wait_for_function("$('saveStatus').textContent.includes('Đã lưu')")
        assert saves[-1]["workspaceMode"] == "whiteboard"
        assert len({item["documentId"] for item in saves}) >= 2
        saved = page.evaluate("JSON.stringify(lessonData())")
        page.reload()
        page.wait_for_function("typeof boardW!=='undefined' && boardW>0 && workspaceMode==='whiteboard'")
        assert page.evaluate("JSON.stringify(objects)") == json.dumps(json.loads(saved)["objects"], separators=(",", ":"), ensure_ascii=False)
        page.evaluate("setWorkspaceMode('notebook')")
        assert page.evaluate("$('lessonName').value==='Sổ của tôi' && objects.length===1")
        page.evaluate("setWorkspaceMode('whiteboard')")
        export = page.evaluate("""async () => {
          const rect=whiteboardContentPage();const output=renderPaperPage(rect);
          const pdf=await exportLessonPDF();
          return {negative:rect.x<0&&rect.y<0,w:output.width,h:output.height,pdf:pdf.size,type:pdf.type};
        }""")
        assert export["negative"] and export["w"] > 0 and export["h"] > 0 and export["pdf"] > 1000 and export["type"] == "application/pdf", export
        page.emulate_media(reduced_motion="reduce")
        page.evaluate("document.documentElement.style.fontSize='20px'")
        layout(834, 1194, "whiteboard-large-text")
        assert not errors, errors
        print("PASS both workspaces survive save/reload; whole-board PNG/PDF includes negative coordinates; dark/reduced-motion layouts")
        print(f"Screenshots: {shots}")
        browser.close()


if __name__ == "__main__":
    run()
