"""Run: python tests/test_inequality_browser.py (Python Playwright + Chrome).
HTTP requests and saves are mocked; no existing lesson is modified.
"""
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
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("sessionStorage.setItem('qh-authenticated', 'true')")

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
        page.goto("http://localhost/index.html")
        page.wait_for_function("typeof boardW !== 'undefined' && boardW > 0")
        page.evaluate(r"""() => {
          clearBoardInteraction(); objects=[]; undoStack=[]; redoStack=[];
          view={x:0,y:0,z:1,fit:false};
          addGraph('x >= 0\ny >= 0\nx + y <= 4', 'inequalitySystem');
          objects[0].x=100; objects[0].y=100; selected=0; draw();
        }""")

        # Sample ink away from boundaries, axes and the condition labels.
        samples = page.evaluate("""() => {
          const surface=document.createElement('canvas');surface.width=560;surface.height=420;
          const c=surface.getContext('2d');paintGraph(c,{...objects[0],x:0,y:0});
          return [[1,1],[-1,1],[1,-1],[3,2]].map(([x,y]) => {
            const data=c.getImageData(280+x*50-6,210-y*50-6,12,12).data;
            let ink=0;for(let i=0;i<data.length;i+=4)if(data[i]<200)ink++;
            return ink;
          });
        }""")
        assert samples[0] > 10, f"Solution must be hatched: {samples}"
        assert samples[1:] == [0, 0, 0], f"Rejected regions must remain white: {samples}"
        print("PASS hatching covers only the common solution of all three inequalities")

        def screen(x, y):
            return page.evaluate("""([x,y])=>{
              const r=canvas.getBoundingClientRect();return [r.left+view.x+x*view.z,r.top+view.y+y*view.z];
            }""", [x, y])

        page.mouse.move(*screen(660, 520))
        page.mouse.down()
        page.mouse.move(*screen(380, 310), steps=8)
        page.mouse.up()
        assert page.evaluate("[objects[0].w,objects[0].h]") == [280, 210]
        page.keyboard.press("Control+z")
        assert page.evaluate("[objects[0].w,objects[0].h]") == [560, 420]
        page.keyboard.press("Control+Shift+z")
        assert page.evaluate("[objects[0].w,objects[0].h]") == [280, 210]
        print("PASS corner drag shrinks the graph; undo and redo restore its dimensions")

        # Every resized graph must match a scaled complete drawing, including
        # the diagonal boundary, hatch spacing, tick labels and condition text.
        page.evaluate("""() => {
          const surface=document.createElement('canvas');
          const reference=document.createElement('canvas');
          for(const expression of ['x >= 0;y >= 0;x + y <= 4','x^2 + y^2 <= 16','y > x']) {
            for(const [w,h] of [[280,210],[140,105],[280,168],[112,84],[40,40]]) {
              surface.width=reference.width=w;surface.height=reference.height=h;
              const object={...objects[0],expression,x:0,y:0,w,h};
              paintGraph(surface.getContext('2d'),object);
              const c=reference.getContext('2d');c.scale(w/560,h/420);
              paintGraph(c,{...object,w:560,h:420});
              if(surface.toDataURL()!==reference.toDataURL())
                throw new Error(`Resized drawing lost content: ${expression}, ${w}x${h}`);
            }
          }
          const before=document.createElement('canvas');before.width=280;before.height=210;
          paintGraph(before.getContext('2d'),{...objects[0],x:0,y:0});
          applyDoc(validateDoc(JSON.parse(JSON.stringify(lessonData()))));
          const after=document.createElement('canvas');after.width=280;after.height=210;
          paintGraph(after.getContext('2d'),{...objects[0],x:0,y:0});
          if(before.toDataURL()!==after.toDataURL())throw new Error('Reload changed the graph');
        }""")
        print("PASS complete drawing scales at five sizes for linear, circular and strict inequalities; document reload preserves it")
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    run()
