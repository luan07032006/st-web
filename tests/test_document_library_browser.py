"""Real server + persistent Chrome profile, with isolated data and browser directories.

Run: python tests/test_document_library_browser.py
No files in Backend/data are read or changed by this test.
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
    with tempfile.TemporaryDirectory(prefix="bangtrang-library-", ignore_cleanup_errors=True) as temporary:
        folder = Path(temporary)
        data = folder / "data"
        data.mkdir()
        legacy = {"version": 1, "title": "Bài giảng cũ", "workspaceMode": "notebook", "objects": [
            {"type": "text", "x": 100, "y": 150, "size": 22, "color": "#24304a", "text": "Nội dung cần giữ"}],
            "paper": {"format": "a4", "pages": 2, "color": "#faf8e8"}, "background": "grid",
            "view": {"x": 0, "y": 0, "z": 1, "fit": False}, "theme": "light",
            "alternateWorkspace": {"mode": "whiteboard", "document": {"version": 1, "title": "Bảng cũ", "objects": [
                {"type": "text", "x": -100, "y": 80, "size": 24, "color": "#24304a", "text": "Ý tưởng cũ"}],
                "paper": {"format": "infinite", "pages": 1, "color": "#ffffff"}, "background": "dots"}}}
        legacy_bytes = json.dumps(legacy, ensure_ascii=False).encode("utf-8")
        (data / "lesson.json").write_bytes(legacy_bytes)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        base = f"http://localhost:{port}"
        env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1", "BOARD_DATA_DIR": str(data)}

        def api(path, payload=None):
            request = Request(base + path, data=json.dumps(payload).encode() if payload is not None else None,
                              headers={"Content-Type": "application/json"}, method="PUT" if payload is not None else "GET")
            with urlopen(request, timeout=5) as response:
                return json.loads(response.read())

        def start_server():
            process = subprocess.Popen(["java", "-cp", f"{ROOT / 'Backend/target/classes'}{os.pathsep}{ROOT / 'Backend/target/lasso-dependencies/*'}", "vn.bangtrang.backend.Main"],
                                       cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            for _ in range(60):
                if process.poll() is not None:
                    raise AssertionError(process.stdout.read().decode("utf-8", errors="replace"))
                try:
                    api("/api/documents")
                    return process
                except OSError:
                    time.sleep(.1)
            process.terminate()
            raise AssertionError("Server did not start")

        server = start_server()
        shots = Path(tempfile.gettempdir()) / "bangtrang-library-qa"
        shots.mkdir(exist_ok=True)
        errors = []
        try:
            with sync_playwright() as playwright:
                chrome = Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe"

                def launch(profile):
                    context = playwright.chromium.launch_persistent_context(str(profile), viewport={"width": 1194, "height": 834},
                        device_scale_factor=2, has_touch=True, **({"executable_path": str(chrome)} if chrome.exists() else {}))
                    page = context.pages[0] if context.pages else context.new_page()
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    return context, page

                def login(page):
                    page.goto(base + "/login.html")
                    page.locator("#username").fill("QuynhHuong")
                    page.locator("#password").fill("255205")
                    page.locator('button[type="submit"]').click()
                    page.wait_for_url("**/index.html")
                    page.wait_for_function("typeof DocumentStore!=='undefined'")

                def new_document(page, kind, title, editor=False):
                    page.locator("#newDocumentTab" if editor else "#newDocument").click()
                    page.locator("#newDocumentName").fill(title)
                    page.locator(f'[data-create-kind="{kind}"]').click()
                    page.wait_for_url("**/editor.html?document=*")
                    page.wait_for_function("title=>window.documentWorkspace?.ready && document.querySelector('#lessonName').value===title", arg=title)
                    page.evaluate("documentReady")
                    return page.evaluate("documentWorkspace.activeId")

                context, page = launch(folder / "profile")
                login(page)
                page.wait_for_function("document.querySelectorAll('.document-card').length===2")
                page.wait_for_function("!document.querySelector('#libraryStatus').textContent.includes('Đang')")
                assert (data / "lesson.json").read_bytes() == legacy_bytes
                print("PASS legacy notebook and whiteboard migrate separately; the original lesson file stays intact")
                notebook = new_document(page, "notebook", "Toán 11")
                expected_notebook = page.evaluate("""async () => {
                  canvas.setPointerCapture=()=>{};chooseTool('pen');
                  const send=(type,x,y,t)=>{const r=canvas.getBoundingClientRect();const e=new PointerEvent(type,{pointerId:40,pointerType:'pen',button:0,buttons:type==='pointerup'?0:1,clientX:r.left+view.x+x*view.z,clientY:r.top+view.y+y*view.z,pressure:.65,tiltX:25});Object.defineProperty(e,'timeStamp',{value:t});canvas.dispatchEvent(e)};
                  send('pointerdown',150,200,100);
                  for(let i=1;i<=24;i++)send('pointermove',150+i*3,200+Math.sin(i/5)*25,100+i*5);
                  send('pointerup',222,200+Math.sin(24/5)*25,225);
                  const image=document.createElement('canvas');image.width=image.height=16;image.getContext('2d').fillRect(0,0,16,16);
                  objects.push({type:'image',src:image.toDataURL('image/png'),x:120,y:330,w:80,h:80});
                  paperPageCount=3;paperBackground='lined';paperColor='#eef5ed';changed();await saveLesson();
                  await new Promise(r=>requestAnimationFrame(r));
                  return {objects:JSON.stringify(objects),pages:paperPageCount,background:paperBackground,color:paperColor};
                }""")
                board = new_document(page, "whiteboard", "Ý tưởng bài giảng", editor=True)
                assert notebook != board and page.evaluate("objects.length") == 0
                expected_board = page.evaluate("""async () => {
                  objects=[{type:'text',text:'Bảng vô hạn',x:-250,y:-180,size:26,color:'#24304a'}];
                  view={x:480,y:320,z:1.35,fit:false,manualPan:true};changed();await saveLesson();
                  return {objects:JSON.stringify(objects),view:JSON.stringify(view)};
                }""")
                page.locator(f'.document-tab[data-document-id="{notebook}"] [role="tab"]').click()
                page.wait_for_function("id=>documentWorkspace.ready&&documentWorkspace.activeId===id", arg=notebook)
                assert page.evaluate("JSON.stringify(objects)") == expected_notebook["objects"]
                assert page.evaluate("paperPageCount") == 3
                page.locator(f'.document-tab[data-document-id="{board}"] .close-document-tab').click()
                assert page.locator(f'.document-tab[data-document-id="{board}"]').count() == 0
                page.locator("#libraryHome").click()
                page.wait_for_url("**/index.html")
                page.wait_for_function("document.querySelectorAll('.document-card').length===4")
                for width, height, name in [(1194, 834, "home-landscape"), (834, 1194, "home-portrait"), (375, 812, "home-phone")]:
                    page.set_viewport_size({"width": width, "height": height})
                    page.screenshot(path=str(shots / f"{name}.png"))
                    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth"), name
                page.set_viewport_size({"width": 1194, "height": 834})
                page.locator(f'.document-card[data-document-id="{board}"] .favorite-button').click()
                page.wait_for_function("id=>document.querySelector(`[data-document-id='${id}'] .favorite-button`).getAttribute('aria-pressed')==='true'", arg=board)
                page.locator('[data-filter="favorite"]').click()
                assert page.locator(".document-card").count() == 1
                page.locator('[data-filter="all"]').click()
                page.locator("#searchDocuments").click()
                page.locator("#searchDocuments").fill("Toán")
                assert page.locator(".document-card").count() == 1
                page.locator("#closeSearch").click()
                assert page.locator(".document-card").count() == 4
                page.locator('[data-kind-filter="notebook"]').click()
                assert page.locator(".document-card").count() == 2
                page.locator('[data-kind-filter="whiteboard"]').click()
                assert page.locator(".document-card").count() == 2
                page.locator('[data-kind-filter="all"]').click()
                page.locator('[data-library-view="list"]').click()
                assert page.locator("#libraryMain").get_attribute("data-view") == "list"
                assert page.locator(".document-card").count() == 4
                page.locator('[data-library-view="grid"]').click()
                page.locator('[data-quick-kind="notebook"]').click()
                assert page.locator("#newDocumentDialog").is_visible()
                assert page.locator('[data-create-kind="notebook"]').evaluate("button=>button===document.activeElement")
                page.keyboard.press("Escape")
                page.keyboard.press("Control+k")
                assert page.locator("#searchDocuments").evaluate("input=>input===document.activeElement")
                page.evaluate("DocumentStore.syncPending()")
                assert len(api("/api/documents")) == 4
                assert json.dumps(api(f"/api/documents/{notebook}")["objects"], separators=(",", ":"), ensure_ascii=False) == expected_notebook["objects"]
                context.close()
                print("PASS distinct document tabs, closing tabs keeps files, favorites/search, iPad/phone library layout and server backup")

                # Close every Chrome process for this profile; login starts a new session.
                context, page = launch(folder / "profile")
                login(page)
                page.wait_for_function("document.querySelectorAll('.document-card').length===4")
                page.locator(f'.document-card[data-document-id="{notebook}"] .document-open').click()
                page.wait_for_url("**/editor.html?document=*")
                page.evaluate("documentReady")
                page.wait_for_function("window.documentWorkspace?.ready")
                assert page.evaluate("JSON.stringify(objects)") == expected_notebook["objects"]
                assert page.evaluate("[paperPageCount,paperBackground,paperColor]") == [3, "lined", "#eef5ed"]
                page.locator("#libraryHome").click()
                page.wait_for_url("**/index.html")
                page.locator(f'.document-card[data-document-id="{board}"] .document-open').click()
                page.wait_for_url("**/editor.html?document=*")
                page.evaluate("documentReady")
                assert page.evaluate("JSON.stringify(objects)") == expected_board["objects"]
                assert page.evaluate("JSON.stringify(view)") == expected_board["view"]
                page.screenshot(path=str(shots / "editor-tabs.png"))
                print("PASS browser close/reopen + fresh login preserve exact ink/raw vectors, images, all pages, paper and whiteboard view")

                # Network failure must not discard local edits or falsely claim server saving.
                page.route("**/api/documents/**", lambda route: route.abort())
                offline_objects = page.evaluate("""async () => {
                  objects.push({type:'text',text:'Viết khi mất kết nối',x:20,y:200,size:24,color:'#24304a'});changed();
                  await saveLesson();await DocumentStore.sync(documentWorkspace.activeId);
                  return JSON.stringify(objects);
                }""")
                assert "thiết bị" in page.locator("#saveStatus").text_content()
                context.close()
                context, page = launch(folder / "profile")
                login(page)
                page.wait_for_function("document.querySelectorAll('.document-card').length===4")
                page.locator(f'.document-card[data-document-id="{board}"] .document-open').click()
                page.wait_for_url("**/editor.html?document=*")
                page.evaluate("documentReady")
                assert page.evaluate("JSON.stringify(objects)") == offline_objects
                page.evaluate("DocumentStore.syncPending()")
                assert json.dumps(api(f"/api/documents/{board}")["objects"], separators=(",", ":"), ensure_ascii=False) == offline_objects
                archive = page.evaluate("DocumentStore.backup()")
                assert archive["format"] == "bangtrang-library" and len(archive["documents"]) == 4
                context.close()
                print("PASS offline edits survive closing the browser and retry to the server; editable full-library backup")

                # Restart the Java process, then use a completely different browser database.
                server.terminate();server.wait(timeout=10);server = start_server()
                assert len(api("/api/documents")) == 4
                context, page = launch(folder / "fresh-profile")
                context.add_init_script("Object.defineProperty(crypto,'randomUUID',{value:undefined});Object.defineProperty(crypto,'subtle',{value:undefined})")
                login(page)
                page.wait_for_function("document.querySelectorAll('.document-card').length===4")
                page.locator(f'.document-card[data-document-id="{board}"] .document-open').click()
                page.wait_for_url("**/editor.html?document=*")
                page.evaluate("documentReady")
                assert page.evaluate("JSON.stringify(objects)") == offline_objects
                assert (data / "lesson.json").read_bytes() == legacy_bytes
                latest = api(f"/api/documents/{board}")
                stale = {**latest, "revision": latest["revision"] - 1, "objects": []}
                try:
                    api(f"/api/documents/{board}", stale)
                    raise AssertionError("Stale server write was accepted")
                except HTTPError as error:
                    assert error.code == 409
                assert api(f"/api/documents/{board}")["objects"] == latest["objects"]
                assert page.evaluate("""async () => {
                  const original=DocumentStore.save;
                  DocumentStore.save=async()=>{throw new DOMException('Thiết bị hết dung lượng','QuotaExceededError')};
                  const saved=await saveLesson();const honest=!saved&&$('saveStatus').textContent.includes('Chưa lưu được');
                  DocumentStore.save=original;await saveLesson();return honest;
                }""")
                restored = page.evaluate("archive=>DocumentStore.restore(archive)", archive)
                assert restored == 4
                assert len(page.evaluate("DocumentStore.list()")) == 8
                originals = {item["documentId"] for item in archive["documents"]}
                copies = [item for item in page.evaluate("DocumentStore.list()") if item["documentId"] not in originals]
                assert len(copies) == 4
                for copy in copies:
                    contents = page.evaluate("id=>DocumentStore.get(id)", copy["documentId"])
                    original = next(item for item in archive["documents"] if item["title"] == contents["title"])
                    assert contents["objects"] == original["objects"]
                assert not errors, errors
                context.close()
                print("PASS Java restart + fresh browser restore saved files without duplicate migrations; stale writes cannot replace newer saves")
                print("PASS local HTTP crypto fallbacks, honest save failure status and backup restore keeps originals plus editable copies")
                print(f"Screenshots: {shots}")
        finally:
            if server.poll() is None:
                server.terminate();server.wait(timeout=10)


if __name__ == "__main__":
    run()
