"""Table editing, canvas interactions and real disk persistence with isolated data.

Run: python tests/test_table_tool_browser.py
Never reads or writes Backend/data or the user's Chrome profile.
"""
import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run():
    with tempfile.TemporaryDirectory(prefix="bangtrang-tables-", ignore_cleanup_errors=True) as temporary:
        folder = Path(temporary)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        base = f"http://localhost:{port}"
        env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1", "BOARD_DATA_DIR": str(folder / "data")}
        server = subprocess.Popen(["java", "-cp", f"{ROOT / 'Backend/target/classes'}{os.pathsep}{ROOT / 'Backend/target/lasso-dependencies/*'}", "vn.bangtrang.backend.Main"],
            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)

        def api(path, payload=None):
            request = Request(base + path, data=json.dumps(payload).encode() if payload is not None else None,
                headers={"Content-Type": "application/json"}, method="PUT" if payload is not None else "GET")
            with urlopen(request, timeout=5) as response:
                return json.loads(response.read())

        try:
            for _ in range(60):
                if server.poll() is not None:
                    raise AssertionError(server.stdout.read().decode("utf-8", errors="replace"))
                try:
                    api("/api/documents")
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError("Server did not start")

            with sync_playwright() as playwright:
                chrome = Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe"
                browser = playwright.chromium.launch(**({"executable_path": str(chrome)} if chrome.exists() else {}))
                context = browser.new_context(viewport={"width": 1194, "height": 834}, has_touch=True, device_scale_factor=2)
                context.add_init_script("sessionStorage.setItem('qh-authenticated','true')")
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(base + "/editor.html")
                page.wait_for_function("window.documentWorkspace?.ready")
                document_id = page.evaluate("documentWorkspace.activeId")
                page.locator("#tableBtn").tap()
                shots = Path(tempfile.gettempdir()) / "bangtrang-table-qa"
                shots.mkdir(exist_ok=True)
                for width, height, label in [(1194, 834, "landscape"), (834, 1194, "portrait"), (375, 812, "phone")]:
                    page.set_viewport_size({"width": width, "height": height})
                    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth"), label
                    assert page.locator("#insertTable").is_visible()
                    assert page.locator("#closeTable").bounding_box()["width"] >= 44
                    page.screenshot(path=str(shots / f"dialog-{label}.png"))
                page.set_viewport_size({"width": 1194, "height": 834})
                page.locator('#tablePreview textarea[aria-label="Hàng 1, cột 1"]').fill("Môn học")
                page.locator('#tablePreview textarea[aria-label="Hàng 1, cột 2"]').fill("Điểm số")
                page.locator('#tablePreview textarea[aria-label="Hàng 2, cột 1"]').fill("Toán học")
                page.locator('#tablePreview textarea[aria-label="Hàng 2, cột 2"]').fill("9,5")
                page.locator("#tableRows").fill("5")
                page.locator("#tableColumns").fill("4")
                assert page.locator("#tablePreview textarea").count() == 20
                assert page.locator('#tablePreview textarea[aria-label="Hàng 2, cột 1"]').input_value() == "Toán học"
                page.locator("#tableRows").fill("0")
                page.locator("#insertTable").click()
                assert page.locator("#tableDialog").is_visible() and page.evaluate("objects.length") == 0
                page.locator("#tableRows").fill("4")
                page.locator("#tableColumns").fill("3")
                page.locator("#insertTable").click()
                assert page.evaluate("objects[0].rows===4 && objects[0].columns===3 && objects[0].cells[1][1]==='9,5'")
                assert page.locator("#editTableBtn").is_visible()
                page.evaluate("undo()")
                assert page.evaluate("objects.length") == 0
                page.evaluate("redo()")
                assert page.evaluate("objects[0].cells[1][0]") == "Toán học"
                print("PASS touch dialog, row/column selection, retained cell data, validation and undo/redo")

                def point(expression):
                    return page.evaluate("""expression => {
                      const p=eval(expression),r=canvas.getBoundingClientRect();
                      return {x:r.left+view.x+p.x*view.z,y:r.top+view.y+p.y*view.z};
                    }""", expression)

                before = page.evaluate("({x:objects[0].x,y:objects[0].y,w:objects[0].w,h:objects[0].h})")
                start = point("({x:objects[0].x+60,y:objects[0].y+60})")
                page.mouse.move(start["x"], start["y"])
                page.mouse.down()
                page.mouse.move(start["x"] + 24, start["y"] + 18, steps=4)
                page.mouse.up()
                assert page.evaluate("objects[0].x") > before["x"]
                corner = point("({x:objects[0].x+objects[0].w,y:objects[0].y+objects[0].h})")
                page.mouse.move(corner["x"], corner["y"])
                page.mouse.down()
                page.mouse.move(corner["x"] + 40, corner["y"] + 25, steps=4)
                page.mouse.up()
                assert page.evaluate("objects[0].w") > before["w"]
                page.locator("#editTableBtn").tap()
                page.locator('#tablePreview textarea[aria-label="Hàng 3, cột 1"]').fill("Vật lý\nHọc kỳ 1")
                page.locator("#tableHeader").uncheck()
                page.locator("#insertTable").click()
                start = point("({x:objects[0].x+50,y:objects[0].y+30})")
                page.mouse.dblclick(start["x"], start["y"])
                assert page.locator("#tableDialog").is_visible()
                assert page.locator('#tablePreview textarea[aria-label="Hàng 3, cột 1"]').input_value() == "Vật lý\nHọc kỳ 1"
                page.keyboard.press("Escape")
                assert not page.locator("#tableDialog").is_visible()
                page.evaluate("""() => {
                  canvas.setPointerCapture=()=>{};chooseTool('pen');
                  const t=objects[0],r=canvas.getBoundingClientRect();
                  const send=(type,i)=>canvas.dispatchEvent(new PointerEvent(type,{pointerId:80,pointerType:'pen',button:0,
                    buttons:type==='pointerup'?0:1,pressure:.6,clientX:r.left+view.x+(t.x+20+i*3)*view.z,
                    clientY:r.top+view.y+(t.y+t.h-20+Math.sin(i)*3)*view.z}));
                  send('pointerdown',0);for(let i=1;i<15;i++)send('pointermove',i);send('pointerup',15);
                }""")
                page.wait_for_function("objects.length===2")
                page.screenshot(path=str(shots / "table-notebook.png"))
                page.evaluate("applyTheme('dark')")
                page.locator("#tableBtn").click()
                page.screenshot(path=str(shots / "dialog-dark.png"))
                page.keyboard.press("Escape")
                page.evaluate("applyTheme('light')")
                assert page.evaluate("async ()=>(await exportLessonPDF()).size>1500")
                await_saved = page.evaluate("""async () => {
                  await documentWorkspace.flush();await DocumentStore.sync(documentWorkspace.activeId);
                  return JSON.stringify(objects);
                }""")
                stored = api(f"/api/documents/{document_id}")
                assert stored["objects"][0]["cells"][2][0] == "Vật lý\nHọc kỳ 1"
                assert len(stored["objects"]) == 2
                page.reload()
                page.wait_for_function("window.documentWorkspace?.ready")
                assert page.evaluate("JSON.stringify(objects)") == await_saved
                print("PASS canvas move/resize, editing, pen annotation, PDF, dark mode, disk save and reload")

                # An empty browser can recover the same table from the server's files.
                fresh = browser.new_context(viewport={"width": 834, "height": 1194})
                fresh.add_init_script("sessionStorage.setItem('qh-authenticated','true')")
                other = fresh.new_page()
                other.goto(base + f"/editor.html?document={document_id}")
                other.wait_for_function("window.documentWorkspace?.ready")
                assert other.evaluate("JSON.stringify(objects)") == await_saved
                invalid = {**stored, "revision": stored["revision"] + 100}
                invalid["objects"] = [{**stored["objects"][0], "columns": 0}]
                try:
                    api(f"/api/documents/{document_id}", invalid)
                    raise AssertionError("Server accepted malformed table")
                except HTTPError as error:
                    assert error.code == 400
                assert page.evaluate("""() => {
                  const bad=structuredClone(lessonData());bad.objects[0].cells[0]=[];
                  try {validateDoc(bad);return false;} catch {return true;}
                }""")
                page.locator("#newDocumentTab").click()
                page.locator('[data-create-kind="whiteboard"]').click()
                page.wait_for_function("window.documentWorkspace?.ready && workspaceMode==='whiteboard'")
                page.locator("#tableBtn").click()
                page.locator("#tableRows").fill("20")
                page.locator("#tableColumns").fill("12")
                assert page.locator("#tablePreview textarea").count() == 240
                page.locator("#insertTable").click()
                assert page.evaluate("objects[0].rows===20 && objects[0].columns===12")
                assert page.evaluate("async ()=>(await exportLessonPDF()).size>1500")
                assert not errors, errors
                fresh.close()
                context.close()
                browser.close()
                print("PASS fresh browser recovery, frontend/server validation and maximum-size whiteboard table")
                print(f"Screenshots: {shots}")
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == "__main__":
    run()
