"""Run: python tests/test_lasso_browser.py (Python Playwright + Chrome).
All HTTP requests and saves are mocked; no existing lesson is modified.
"""
import copy
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlsplit, unquote
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run():
    with sync_playwright() as playwright:
        chrome = Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe"
        browser = playwright.chromium.launch(**({"executable_path": str(chrome)} if chrome.exists() else {}))
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        errors, saves = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("sessionStorage.setItem('qh-authenticated', 'true')")

        def serve(route):
            path = unquote(urlsplit(route.request.url).path)
            if path.startswith('/api/'):
                if route.request.method == "PUT":
                    saves.append(json.loads(route.request.post_data))
                route.fulfill(content_type='application/json', body='{}')
                return
            resource = ROOT / "Frontend" / path.lstrip('/')
            if resource.is_file():
                route.fulfill(body=resource.read_bytes(), content_type=mimetypes.guess_type(str(resource))[0] or 'application/octet-stream')
            else:
                route.fulfill(status=404, body='Not found')

        page.route("**/*", serve)
        page.goto('http://localhost/index.html')
        page.wait_for_function("typeof boardW !== 'undefined' && boardW > 0")

        def seed():
            page.evaluate("""async () => {
              clearBoardInteraction();
              const surface=document.createElement('canvas');surface.width=240;surface.height=100;
              const c=surface.getContext('2d');
              c.fillStyle='#eb4170';c.fillRect(0,0,240,100);
              c.fillStyle='#20a575';c.fillRect(100,0,140,50);
              c.fillStyle='#4638cc';c.fillRect(0,50,240,50);
              const src=surface.toDataURL('image/png'),image=new Image();
              image.src=src;await image.decode();images.set(src,image);
              objects=[
                {type:'pen',color:'#245bea',width:6,points:[{x:80,y:220,p:1},{x:420,y:220,p:0.8}]},
                {type:'highlight',color:'#f0b43c',width:8,points:[{x:100,y:260,p:1},{x:410,y:260,p:1}]},
                {type:'text',text:'Lasso giu nguyen',size:26,color:'#24304a',x:140,y:300},
                {type:'rectangle',color:'#42a987',width:3,x:250,y:340,w:180,h:70,
                  vertices:[{x:250,y:340},{x:430,y:340},{x:430,y:410},{x:250,y:410}]},
                {type:'image',src,x:120,y:440,w:240,h:100}
              ];
              view={x:0,y:0,z:1,fit:false};paperPageCount=2;undoStack=[];redoStack=[];
              chooseTool('pen');draw();
            }""")

        def screen(x,y):
            return page.evaluate("""([x,y])=>{
              const r=canvas.getBoundingClientRect();return [r.left+view.x+x*view.z,r.top+view.y+y*view.z];
            }""",[x,y])

        def move(x,y):
            page.mouse.move(*screen(x,y))

        def drag(a,b):
            move(*a);page.mouse.down();page.mouse.move(*screen(*b),steps=12);page.mouse.up()

        def state():
            return page.evaluate("JSON.parse(JSON.stringify(objects))")

        def pixels(x,y,w,h):
            return page.evaluate("""([x,y,w,h])=>{
              const c=document.createElement('canvas');c.width=w;c.height=h;
              const context=c.getContext('2d');context.translate(-x,-y);
              objects.forEach(object=>paintObject(context,object));
              const data=context.getImageData(0,0,w,h).data;let visible=false;
              for(let i=3;i<data.length;i+=4)if(data[i]){visible=true;break;}
              return {png:c.toDataURL(),visible};
            }""",[x,y,w,h])

        def select(mode='freeform'):
            page.keyboard.press('v');page.locator(f'[data-lasso-mode="{mode}"]').click()
            if mode=='rectangle':
                drag((330,560),(180,190))
            else:
                move(180,190);page.mouse.down()
                for point in [(330,190),(330,560),(180,560),(180,190)]:
                    page.mouse.move(*screen(*point),steps=6)
                page.mouse.up()
            assert page.evaluate('groupSelection.length')==5

        seed();original=state();crop=pixels(185,195,140,360);outside=pixels(80,210,80,80)
        select()
        assert state()==original and page.evaluate('undoStack.length')==0
        page.mouse.click(*screen(200,350));assert state()==original
        drag((200,350),(550,450))
        assert pixels(535,295,140,360)==crop,'Moved crop must keep exactly the same pixels'
        assert not pixels(185,195,140,360)['visible'],'Source crop must disappear'
        assert pixels(80,210,80,80)==outside,'Outside content must stay unchanged'
        pieces=state()[5:];assert len(pieces)==5
        assert pieces[0]['width']==6 and pieces[0]['points'][1]['p']==0.8
        assert pieces[1]['width']==8
        assert pieces[2]['text']==original[2]['text'] and pieces[2]['size']==26
        assert pieces[3]['w']==180 and pieces[3]['h']==70
        assert pieces[4]['src']==original[4]['src'] and pieces[4]['w']==240 and pieces[4]['h']==100
        page.wait_for_timeout(750);assert saves[-1]['objects']==state()
        moved=state();page.keyboard.press('Control+z');assert state()==original
        page.keyboard.press('Control+Shift+z');assert state()==moved and pixels(535,295,140,360)==crop
        page.evaluate('applyDoc(validateDoc(JSON.parse(JSON.stringify(lessonData()))));changed()')
        assert state()==moved and pixels(535,295,140,360)==crop
        print('PASS partial pen/highlight/text/geometry/image cuts: identical pixels, sizes, save/restore and undo/redo')

        seed();select('rectangle');drag((200,350),(550,450));drag((550,450),(600,470))
        assert len(state())==10,'Repeated drags must not add pieces'
        assert pixels(585,315,140,360)==crop and page.evaluate('undoStack.length')==2
        page.keyboard.press('Escape');assert page.evaluate('groupRegion') is None
        print('PASS reverse rectangle, repeated movement and Escape')

        for cancel in ['pointercancel','Escape','Control+z','b']:
            seed();select();move(200,350);page.mouse.down();move(550,450)
            if cancel=='pointercancel':
                page.locator('#board').dispatch_event('pointercancel',{'pointerId':1,'pointerType':'mouse'})
            else:
                page.keyboard.press(cancel)
            page.mouse.up()
            assert state()==original and page.evaluate('undoStack.length')==0,cancel
        print('PASS cancelled cuts restore content and history')

        seed();select();drag((200,350),(-150,300))
        assert pixels(-165,145,140,360)==crop and page.evaluate('groupBounds().x')==-170
        print('PASS arbitrary positions outside the paper without clamping')

        seed();page.evaluate('view.z=0.5;draw()');select();drag((200,350),(550,450))
        assert pixels(535,295,140,360)==crop
        print('PASS size preservation at 50% zoom')

        seed();page.evaluate('objects=[{...objects[4],x:80,y:200,w:1000,h:1400}];view.z=0.4;draw()')
        page.keyboard.press('v');page.locator('[data-lasso-mode="rectangle"]').click()
        drag((60,180),(1100,1620));drag((200,400),(250,460))
        assert state()[0]['w']==1000 and state()[0]['h']==1400
        assert state()[1]['w']==1000 and state()[1]['h']==1400
        assert state()[1]['x']==130 and state()[1]['y']==260
        page.evaluate('changed()');assert state()[1]['w']==1000 and state()[1]['h']==1400
        print('PASS crop larger than A4 moves and saves without shrinking')

        seed();page.evaluate('objects=[{...objects[4],pdfBackground:true,pdfPage:1}];draw()')
        source=pixels(185,445,140,90)
        page.keyboard.press('v');page.locator('[data-lasso-mode="rectangle"]').click()
        drag((180,430),(330,550));drag((200,470),(550,570))
        assert pixels(535,545,140,90)==source
        assert not state()[1].get('pdfBackground') and state()[0]['pdfBackground']
        print('PASS partial PDF cuts preserve page layout')

        seed();inside=pixels(200,460,10,10);outside_triangle=pixels(310,520,10,10)
        page.keyboard.press('v');page.locator('[data-lasso-mode="freeform"]').click()
        move(180,440);page.mouse.down()
        for point in [(330,440),(180,540),(180,440)]:
            page.mouse.move(*screen(*point),steps=6)
        page.mouse.up();drag((200,470),(550,570))
        assert pixels(550,560,10,10)==inside
        assert not pixels(200,460,10,10)['visible']
        assert pixels(310,520,10,10)==outside_triangle
        assert not pixels(660,620,10,10)['visible']
        print('PASS freeform boundary cuts only the enclosed shape, not its bounding rectangle')

        seed()
        def board_pixel(x,y):
            return page.evaluate("""([x,y])=>{
              const dpr=window.devicePixelRatio||1;
              return [...ctx.getImageData(Math.round((view.x+x*view.z)*dpr),
                Math.round((view.y+y*view.z)*dpr),1,1).data];
            }""",[x,y])
        open_edge=board_pixel(180,490);inside_preview=board_pixel(240,470)
        page.keyboard.press('v')
        assert page.evaluate('lassoMode')=='freeform'
        move(180,440);page.mouse.down()
        for point in [(200,430),(260,420),(330,440),(300,500),(260,530),(180,540)]:
            page.mouse.move(*screen(*point),steps=5)
        assert page.evaluate('groupRegion') is None
        assert board_pixel(180,490)==open_edge,'Freehand preview must not draw a closing edge'
        assert board_pixel(240,470)==inside_preview,'Freehand preview must not fill a preset region'
        page.mouse.up()
        assert page.evaluate('groupRegion.length')>10
        before=state()
        # Reactivating freehand must let a new outline start inside the old one.
        page.keyboard.press('v')
        assert page.evaluate('groupRegion') is None
        move(230,470);page.mouse.down();move(250,480)
        assert not page.evaluate('Boolean(start.groupMove)')
        assert state()==before
        page.keyboard.press('Escape');page.mouse.up()
        # V also returns from rectangle mode to drawing freehand.
        page.locator('[data-lasso-mode="rectangle"]').click()
        page.keyboard.press('v')
        assert page.locator('[data-lasso-mode="freeform"]').get_attribute('aria-pressed')=='true'
        select()
        selected_region=page.evaluate('JSON.stringify(groupRegion)')
        page.keyboard.press('Space');page.keyboard.up('Space')
        assert page.evaluate('JSON.stringify(groupRegion)')==selected_region
        print('PASS drawn outline, open preview, fresh freehand selection and pan preservation')

        seed();select();cdp=page.context.new_cdp_session(page)
        def touch(kind,points):
            cdp.send('Input.dispatchTouchEvent',{'type':kind,'touchPoints':[
                {'x':screen(x,y)[0],'y':screen(x,y)[1],'id':i}for i,(x,y)in enumerate(points)]})
        touch('touchStart',[(200,350)]);touch('touchMove',[(550,450)]);touch('touchEnd',[])
        assert pixels(535,295,140,360)==crop
        before=state();touch('touchStart',[(550,450)]);touch('touchMove',[(600,470)])
        touch('touchStart',[(600,470),(720,600)]);touch('touchEnd',[])
        assert state()==before
        print('PASS touch movement and two-finger gesture cancellation')

        invalid=copy.deepcopy(saves[-1]);invalid['objects'][0]['cutouts']=[[{'x':0,'y':0}]]
        assert page.evaluate('data=>{try{validateDoc(data);return false}catch{return true}}',invalid)
        assert not errors,errors
        print('PASS mask validation and no browser JavaScript errors')
        fixture=Path(os.environ.get('TEMP', str(ROOT))) / 'st-web-lasso-fixture.json'
        fixture.write_text(json.dumps(saves[-1]), encoding='utf-8')
        browser.close()


if __name__=='__main__':
    run()
