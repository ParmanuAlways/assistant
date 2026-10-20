"""'Legacy ERP': a deliberately old-fashioned intranet app with the traps real enterprise web apps have.

  - its own login form (not SSO) and a session that expires once in the middle of a task
  - a frameset (top / nav / main), where the nav menu only opens on mouse hover
  - ASP.NET-style postback links (javascript:__doPostBack) guarded by confirm() / alert() dialogs
  - clickable table cells (onclick on <td>) in a home-made calendar; the date box itself is read-only
  - an autocomplete approver field that only counts if a suggestion is picked
  - a "Lookup..." button that opens a pop-up window to choose a cost centre
  - a masked amount field (keeps digits only and adds commas while you type)
  - a file upload
  - a paginated table of purchase orders whose Approve/Reject buttons live inside Shadow DOM

Graded through /debug/state. Runs on legacy.office.local:8500.
"""
import html
import json
from datetime import date

from fastapi import FastAPI, Form, Request, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

app = FastAPI(title="Legacy ERP")
app.add_middleware(SessionMiddleware, secret_key="legacy-dev-secret", session_cookie="LEGACYSESSID")

USERS = {"ravi": ("ravi123", "Ravi Kumar", "EMP1042")}
EMPLOYEES = [("EMP0900", "Priya Sharma", "Engineering"), ("EMP2001", "Anita Desai", "Internal Audit"),
             ("EMP0001", "Arjun Mehta", "IT"), ("EMP0950", "Priyanka Rao", "Finance"), ("EMP1300", "Pradeep Singh", "Sales")]
COST_CENTRES = [("CC-110", "Engineering - Bangalore"), ("CC-120", "Engineering - Pune"), ("CC-210", "Finance - Mumbai"),
                ("CC-310", "Sales - Delhi"), ("CC-410", "IT - Bangalore")]
VENDORS = ["Acme Supplies", "Globex Traders", "Initech Services", "Umbrella Office", "Stark Hardware"]


def fresh_state():
    return {
        "travel": [], "purchase": [], "timesheets": [], "contact": {"mobile": "9876500011", "landline": ""},
        "pos": [{"po": f"PO-{n}", "vendor": VENDORS[n % 5], "amount": 15000 + (n * 731) % 90000, "status": "Pending"}
                for n in range(1050, 1085)],
        "seats": [],
        "expire_on_contact": True,   # the session expires the first time the contact form is opened
    }


STATE = fresh_state()
EPOCH = [1]

CSS = """body{font-family:Tahoma,Verdana,sans-serif;font-size:13px;margin:0;background:#ece9d8;color:#000}
.box{background:#fff;border:1px solid #7a96df;margin:12px;padding:12px}
h2{font-size:15px;background:#3a6ea5;color:#fff;margin:-12px -12px 12px;padding:6px 12px}
table.form td{padding:4px 6px} input,select,textarea{font:inherit} .err{color:#c00;font-weight:bold}
.ok{color:#060;font-weight:bold;border:1px solid #9c9;background:#efe;padding:8px} a{color:#00c}
.btn{display:inline-block;background:#d4d0c8;border:2px outset #fff;padding:3px 10px;color:#000;text-decoration:none}
table.grid{border-collapse:collapse} table.grid td,table.grid th{border:1px solid #999;padding:3px 8px}
table.grid th{background:#c0c0c0}"""


def doc(title, body, head=""):
    return HTMLResponse(f"""<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><head>
<meta charset="utf-8"><title>{title}</title><style>{CSS}</style>{head}</head><body>{body}</body></html>""")


def user(request):
    # sessions from before the last /debug/reset are invalid, so every test task starts signed out
    if request.session.get("epoch") != EPOCH[0]:
        return None
    return USERS.get(request.session.get("user"), None) and request.session.get("user")


def login_required(request):
    if not user(request):
        nxt = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse(f"/login?next={nxt}", status_code=303)
    return None


# ---------------------------------------------------------------- login + frameset

@app.get("/login", response_class=HTMLResponse)
def login_form(next: str = "/", expired: int = 0, err: int = 0):
    msg = ('<p class="err">Your session has expired. Please sign in again.</p>' if expired else "") + \
          ('<p class="err">Invalid user name or password.</p>' if err else "")
    return doc("Sign in - Legacy ERP", f"""<div class="box" style="width:330px;margin:80px auto"><h2>Legacy ERP - Sign in</h2>{msg}
<form method="post" action="/login" target="_top"><input type="hidden" name="next" value="{html.escape(next)}">
<table class="form"><tr><td>User name</td><td><input id="login_user" name="u"></td></tr>
<tr><td>Password</td><td><input id="login_pass" type="password" name="p"></td></tr>
<tr><td></td><td><input id="login_btn" type="submit" value="Sign in"></td></tr></table></form></div>""")


@app.post("/login")
async def login(request: Request):
    form = await request.form()
    u, p, nxt = form.get("u", ""), form.get("p", ""), form.get("next", "/") or "/"
    if USERS.get(u, (None,))[0] != p:
        return RedirectResponse(f"/login?err=1&next={nxt}", status_code=303)
    request.session["user"] = u
    request.session["epoch"] = EPOCH[0]
    return RedirectResponse("/" if nxt == "/" or nxt.startswith("/login") else f"/?main={nxt}", status_code=303)


@app.get("/", response_class=HTMLResponse)
def frameset(request: Request, main: str = "/home"):
    if r := login_required(request):
        return r
    return HTMLResponse(f"""<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN"><html><head><meta charset="utf-8">
<title>Legacy ERP</title></head><frameset rows="48,*" border="0"><frame name="top" src="/top" scrolling="no">
<frameset cols="210,*"><frame name="nav" src="/nav"><frame name="main" src="{html.escape(main)}"></frameset></frameset></html>""")


@app.get("/top", response_class=HTMLResponse)
def top(request: Request):
    u = user(request) or ""
    return doc("top", f"""<div style="background:#0a246a;color:#fff;padding:12px 14px;font-size:16px">Legacy ERP 7.2
<span style="float:right;font-size:12px">{html.escape(USERS.get(u, ('', ''))[1] if u else '')} &nbsp;
<a href="/logout" target="_top" style="color:#fff">Log off</a></span></div>""")


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/nav", response_class=HTMLResponse)
def nav(request: Request):
    if not user(request):
        return doc("nav", "")
    menu = {"Requests": [("Travel Request", "/travel"), ("Purchase Request", "/purchase"), ("Upload Timesheet", "/timesheet")],
            "Approvals": [("Purchase Orders", "/approvals")],
            "My Profile": [("Contact Details", "/profile/contact")],
            "Facilities": [("Seat Booking", "/seats")],
            "Communication": [("Inward", "/comms?box=in"), ("Outward", "/comms?box=out")]}
    items = "".join(
        f'<li class="m"><span class="mh">{k} &#9656;</span><ul class="sub">' +
        "".join(f'<li><a href="{u}" target="main">{t}</a></li>' for t, u in v) + "</ul></li>" for k, v in menu.items())
    return doc("nav", f"""<div class="box" style="margin:6px;padding:6px"><b>Menu</b><ul id="menu" style="padding-left:14px">{items}</ul>
<p style="font-size:11px;color:#666">Hover over a menu to open it.</p></div>""",
               head="""<style>.sub{display:none;padding-left:14px} .mh{cursor:default;font-weight:bold} li.m{margin:6px 0}</style>
<script>document.addEventListener('DOMContentLoaded',function(){var ms=document.querySelectorAll('li.m');
for(var i=0;i<ms.length;i++){(function(m){m.onmouseenter=function(){for(var j=0;j<ms.length;j++){ms[j].querySelector('.sub').style.display='none';}
m.querySelector('.sub').style.display='block';};})(ms[i]);}});</script>""")


@app.get("/home", response_class=HTMLResponse)
def home(request: Request):
    if r := login_required(request):
        return r
    return doc("Home", """<div class="box"><h2>Welcome</h2><p>Use the menu on the left. Requests and approvals are
processed overnight.</p></div>""")


POSTBACK = """<script>function __doPostBack(t,a){var f=document.forms[0];f.__EVENTTARGET.value=t;f.__EVENTARGUMENT.value=a;
if(t.indexOf('Submit')>=0||t.indexOf('Save')>=0){var msg=f.getAttribute('data-confirm');if(msg&&!confirm(msg.replace('{x}',
(document.getElementById(f.getAttribute('data-confirm-field'))||{}).value||'')))return;}f.submit();}</script>"""


# ---------------------------------------------------------------- L1 travel request (calendar + postback + confirm)

CALENDAR = """<div id="cal" style="display:none;position:absolute;background:#fff;border:1px solid #333;padding:4px;z-index:9"></div>
<script>
var MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
var calTarget=null,calY=2026,calM=9;
function openCal(id){calTarget=id;var c=document.getElementById('cal');var r=document.getElementById(id+'_show').getBoundingClientRect();
 c.style.left=(r.left)+'px';c.style.top=(r.bottom+window.scrollY)+'px';c.style.display='block';drawCal();}
function drawCal(){var c=document.getElementById('cal');var first=new Date(calY,calM,1).getDay();var days=new Date(calY,calM+1,0).getDate();
 var h='<table class="grid"><tr><td onclick="calM--;if(calM<0){calM=11;calY--;}drawCal()" style="cursor:pointer">&lt;</td><td colspan="5" align="center"><b>'+MONTHS[calM]+' '+calY+
 '</b></td><td onclick="calM++;if(calM>11){calM=0;calY++;}drawCal()" style="cursor:pointer">&gt;</td></tr><tr><th>Su</th><th>Mo</th><th>Tu</th><th>We</th><th>Th</th><th>Fr</th><th>Sa</th></tr><tr>';
 for(var i=0;i<first;i++)h+='<td></td>';for(var d=1;d<=days;d++){h+='<td style="cursor:pointer" onclick="pick('+d+')">'+d+'</td>';if((first+d)%7==0)h+='</tr><tr>';}
 c.innerHTML=h+'</tr></table>';}
function pick(d){var m=calM+1;var iso=calY+'-'+(m<10?'0':'')+m+'-'+(d<10?'0':'')+d;document.getElementById(calTarget).value=iso;
 document.getElementById(calTarget+'_show').value=(d<10?'0':'')+d+'-'+MONTHS[calM].substr(0,3)+'-'+calY;document.getElementById('cal').style.display='none';}
</script>"""


@app.get("/travel", response_class=HTMLResponse)
def travel_form(request: Request, err: str = ""):
    if r := login_required(request):
        return r
    e = f'<p class="err">{html.escape(err)}</p>' if err else ""
    opts = "".join(f"<option>{x}</option>" for x in ["Client visit", "Training", "Conference", "Internal meeting"])
    return doc("Travel Request", f"""<div class="box"><h2>Travel Request</h2>{e}
<form method="post" action="/travel" data-confirm="Submit travel request to {{x}}?" data-confirm-field="dest">
<input type="hidden" name="__EVENTTARGET"><input type="hidden" name="__EVENTARGUMENT"><input type="hidden" name="__VIEWSTATE" value="dDwtMTA4NzM2;">
<table class="form"><tr><td>Destination city</td><td><input id="dest" name="destination" size="30"></td></tr>
<tr><td>From date</td><td><input id="from_show" readonly size="12" onclick="openCal('from')" style="background:#eee">
 <img alt="Pick from date" title="Pick from date" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="16" height="16" style="border:1px solid #888;cursor:pointer" onclick="openCal('from')"><input type="hidden" id="from" name="from_date"></td></tr>
<tr><td>To date</td><td><input id="to_show" readonly size="12" onclick="openCal('to')" style="background:#eee">
 <img alt="Pick to date" title="Pick to date" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="16" height="16" style="border:1px solid #888;cursor:pointer" onclick="openCal('to')"><input type="hidden" id="to" name="to_date"></td></tr>
<tr><td>Purpose</td><td><select name="purpose"><option value="">-- select --</option>{opts}</select></td></tr></table>
<p><a class="btn" id="btnSubmit" href="javascript:__doPostBack('btnSubmit','')">Submit</a></p></form>{CALENDAR}</div>""", head=POSTBACK)


@app.post("/travel", response_class=HTMLResponse)
async def travel_submit(request: Request):
    if r := login_required(request):
        return r
    f = await request.form()
    d = {k: f.get(k, "") for k in ("destination", "from_date", "to_date", "purpose")}
    if not all(d.values()):
        return travel_form(request, "All fields are required (pick the dates from the calendar).")
    STATE["travel"].append(d)
    ref = f"TR-{3000 + len(STATE['travel'])}"
    return doc("Saved", f'<div class="box"><h2>Travel Request</h2><p class="ok">Travel request {ref} submitted for approval.</p></div>')


# ---------------------------------------------------------------- L2 purchase request (autocomplete + popup + mask + confirm)

@app.get("/api/employees")
def employees(q: str = ""):
    q = q.lower()
    return [{"id": i, "name": n, "dept": d} for i, n, d in EMPLOYEES if q and q in n.lower()][:5]


@app.get("/purchase", response_class=HTMLResponse)
def purchase_form(request: Request, err: str = ""):
    if r := login_required(request):
        return r
    e = f'<p class="err">{html.escape(err)}</p>' if err else ""
    return doc("Purchase Request", f"""<div class="box"><h2>Purchase Request</h2>{e}
<form method="post" action="/purchase" id="pf">
<table class="form"><tr><td>Item description</td><td><input name="item" size="40"></td></tr>
<tr><td>Quantity</td><td><input name="qty" size="5"></td></tr>
<tr><td>Unit price (INR)</td><td><input id="price" name="price" size="12" autocomplete="off"></td></tr>
<tr><td>Cost centre</td><td><input id="cc_name" readonly size="28" style="background:#eee"><input type="hidden" id="cc" name="cost_centre">
 <input type="button" value="Lookup..." onclick="window.open('/lookup/costcentre','lookup','width=520,height=420')"></td></tr>
<tr><td>Approver</td><td><input id="appr" size="28" autocomplete="off" placeholder="Type a name"><input type="hidden" id="appr_id" name="approver">
 <div id="sugg" style="position:absolute;background:#fff;border:1px solid #888"></div></td></tr></table>
<p><input type="submit" value="Create Request"></p></form></div>""", head="""<script>
function setCostCentre(code,name){document.getElementById('cc').value=code;document.getElementById('cc_name').value=name;}
document.addEventListener('DOMContentLoaded',function(){
 var p=document.getElementById('price');
 p.addEventListener('input',function(){var d=p.value.replace(/[^0-9]/g,'');p.value=d?Number(d).toLocaleString('en-IN'):'';});
 var a=document.getElementById('appr'),s=document.getElementById('sugg');
 a.addEventListener('input',function(){document.getElementById('appr_id').value='';var q=a.value;if(q.length<2){s.innerHTML='';return;}
  fetch('/api/employees?q='+encodeURIComponent(q)).then(function(r){return r.json()}).then(function(list){
   s.innerHTML=list.map(function(e){return '<div class="opt" style="padding:3px 8px;cursor:pointer" data-id="'+e.id+'">'+e.name+' ('+e.dept+')</div>'}).join('');
   [].forEach.call(s.querySelectorAll('.opt'),function(o){o.onclick=function(){a.value=o.textContent;document.getElementById('appr_id').value=o.getAttribute('data-id');s.innerHTML='';};});});});
 document.getElementById('pf').addEventListener('submit',function(ev){
  if(!document.getElementById('cc').value){alert('Please choose a cost centre with Lookup...');ev.preventDefault();return;}
  if(!document.getElementById('appr_id').value){alert('Please pick the approver from the suggestions.');ev.preventDefault();return;}
  var total=(Number(document.getElementById('price').value.replace(/[^0-9]/g,''))||0)*(Number(document.forms[0].qty.value)||0);
  if(!confirm('Create purchase request for INR '+total.toLocaleString('en-IN')+'?'))ev.preventDefault();});
});</script>""")


@app.get("/lookup/costcentre", response_class=HTMLResponse)
def lookup(request: Request):
    rows = "".join(f'<tr><td>{c}</td><td><a href="#" onclick="window.opener.setCostCentre(\'{c}\',\'{n}\');window.close();return false;">{n}</a></td></tr>'
                   for c, n in COST_CENTRES)
    return doc("Select Cost Centre", f'<div class="box"><h2>Select Cost Centre</h2><table class="grid"><tr><th>Code</th><th>Name</th></tr>{rows}</table></div>')


@app.post("/purchase", response_class=HTMLResponse)
async def purchase_submit(request: Request):
    if r := login_required(request):
        return r
    f = await request.form()
    d = {k: f.get(k, "") for k in ("item", "qty", "price", "cost_centre", "approver")}
    if not all(d.values()):
        return purchase_form(request, "Please complete all fields.")
    d["price"] = d["price"].replace(",", "")
    STATE["purchase"].append(d)
    return doc("Saved", f'<div class="box"><h2>Purchase Request</h2><p class="ok">Purchase request PR-{4000 + len(STATE["purchase"])} created and sent for approval.</p></div>')


# ---------------------------------------------------------------- L3 PO approvals (pagination + row actions in Shadow DOM + confirm)

@app.get("/approvals", response_class=HTMLResponse)
def approvals(request: Request, page: int = 1, msg: str = ""):
    if r := login_required(request):
        return r
    per, pos = 10, STATE["pos"]
    pages = (len(pos) + per - 1) // per
    rows = "".join(f"""<tr><td>{p['po']}</td><td>{p['vendor']}</td><td align="right">{p['amount']:,}</td><td>{p['status']}</td>
<td><po-actions po="{p['po']}" amount="{p['amount']}" {'done' if p['status'] != 'Pending' else ''}></po-actions></td></tr>"""
                   for p in pos[(page - 1) * per: page * per])
    pager = " ".join(f'<b>{i}</b>' if i == page else f'<a href="/approvals?page={i}">{i}</a>' for i in range(1, pages + 1))
    nxt = f' <a href="/approvals?page={page + 1}">Next &raquo;</a>' if page < pages else ""
    prv = f'<a href="/approvals?page={page - 1}">&laquo; Prev</a> ' if page > 1 else ""
    m = f'<p class="ok">{html.escape(msg)}</p>' if msg else ""
    return doc("Purchase Orders", f"""<div class="box"><h2>Purchase Orders awaiting approval</h2>{m}
<table class="grid"><tr><th>PO</th><th>Vendor</th><th>Amount (INR)</th><th>Status</th><th>Action</th></tr>{rows}</table>
<p>Page: {prv}{pager}{nxt}</p><form id="act" method="post" action="/approvals"><input type="hidden" name="po"><input type="hidden" name="decision">
<input type="hidden" name="page" value="{page}"></form></div>""", head="""<script>
customElements.define('po-actions', class extends HTMLElement {
  connectedCallback(){ var po=this.getAttribute('po'), amt=Number(this.getAttribute('amount')).toLocaleString('en-IN');
    var root=this.attachShadow({mode:'open'});
    if(this.hasAttribute('done')){root.innerHTML='<span>-</span>';return;}
    root.innerHTML='<button>Approve</button> <button>Reject</button>';
    var b=root.querySelectorAll('button');
    b[0].onclick=function(){ if(confirm('Approve '+po+' for INR '+amt+'?')){var f=document.getElementById('act');f.po.value=po;f.decision.value='Approved';f.submit();}};
    b[1].onclick=function(){ if(confirm('Reject '+po+'?')){var f=document.getElementById('act');f.po.value=po;f.decision.value='Rejected';f.submit();}};
  }});</script>""")


@app.post("/approvals")
async def approve(request: Request):
    if r := login_required(request):
        return r
    f = await request.form()
    for p in STATE["pos"]:
        if p["po"] == f.get("po") and p["status"] == "Pending":
            p["status"] = f.get("decision")
    return RedirectResponse(f"/approvals?page={f.get('page', 1)}&msg={f.get('po')} {f.get('decision', '').lower()}.", status_code=303)


# ---------------------------------------------------------------- L4 timesheet upload (file + alert)

@app.get("/timesheet", response_class=HTMLResponse)
def timesheet_form(request: Request, err: str = ""):
    if r := login_required(request):
        return r
    e = f'<p class="err">{html.escape(err)}</p>' if err else ""
    months = "".join(f"<option>{m} 2026</option>" for m in ["August", "September", "October", "November"])
    return doc("Upload Timesheet", f"""<div class="box"><h2>Upload Timesheet</h2>{e}
<form method="post" action="/timesheet" enctype="multipart/form-data">
<table class="form"><tr><td>Month</td><td><select name="month"><option value="">-- select --</option>{months}</select></td></tr>
<tr><td>Signed timesheet (PDF)</td><td><input type="file" name="file" accept=".pdf"></td></tr>
<tr><td>Remarks</td><td><input name="remarks" size="40"></td></tr></table>
<p><input type="submit" value="Upload"></p></form></div>""")


@app.post("/timesheet", response_class=HTMLResponse)
async def timesheet_submit(request: Request, month: str = Form(""), remarks: str = Form(""), file: UploadFile | None = File(None)):
    if r := login_required(request):
        return r
    data = await file.read() if file else b""
    if not month or not data:
        return timesheet_form(request, "Choose the month and attach the signed timesheet.")
    STATE["timesheets"].append({"month": month, "file": file.filename, "size": len(data), "pdf": data[:4] == b"%PDF",
                                "remarks": remarks})
    return doc("Uploaded", '<div class="box"><h2>Upload Timesheet</h2><p class="ok">Timesheet received.</p></div>',
               head="<script>window.addEventListener('load',function(){alert('Timesheet uploaded successfully');});</script>")


# ---------------------------------------------------------------- L5 contact details (session expiry + mask)

@app.get("/profile/contact", response_class=HTMLResponse)
def contact_form(request: Request, saved: int = 0):
    if r := login_required(request):
        return r
    if STATE["expire_on_contact"]:
        STATE["expire_on_contact"] = False
        request.session.clear()
        return HTMLResponse('<script>top.location="/login?expired=1&next=/profile/contact";</script>')
    c = STATE["contact"]
    ok = '<p class="ok">Contact details saved.</p>' if saved else ""
    fmt = lambda m: f"{m[:5]}-{m[5:]}" if len(m) == 10 else m
    return doc("Contact Details", f"""<div class="box"><h2>Contact Details</h2>{ok}
<form method="post" action="/profile/contact" data-confirm="Save contact details?">
<input type="hidden" name="__EVENTTARGET"><input type="hidden" name="__EVENTARGUMENT">
<table class="form"><tr><td>Mobile</td><td><input id="mobile" name="mobile" value="{fmt(c['mobile'])}" size="14"></td></tr>
<tr><td>Landline</td><td><input name="landline" value="{html.escape(c['landline'])}" size="14"></td></tr></table>
<p><a class="btn" href="javascript:__doPostBack('btnSave','')">Save</a></p></form></div>""", head=POSTBACK + """<script>
document.addEventListener('DOMContentLoaded',function(){var m=document.getElementById('mobile');
m.addEventListener('input',function(){var d=m.value.replace(/[^0-9]/g,'').slice(0,10);m.value=d.length>5?d.slice(0,5)+'-'+d.slice(5):d;});});</script>""")


@app.post("/profile/contact")
async def contact_save(request: Request):
    if r := login_required(request):
        return r
    f = await request.form()
    STATE["contact"] = {"mobile": f.get("mobile", "").replace("-", ""), "landline": f.get("landline", "")}
    return RedirectResponse("/profile/contact?saved=1", status_code=303)


# ---------------------------------------------------------------- L6 seat booking (a seat map drawn on a canvas: no DOM to read)

@app.get("/seats", response_class=HTMLResponse)
def seats_form(request: Request):
    if r := login_required(request):
        return r
    return doc("Seat Booking", """<div class="box"><h2>Hot-desk booking - 3rd floor</h2>
<p>Click a free seat on the map, then press Book seat. Grey seats are taken.</p>
<canvas id="map" width="460" height="250" style="border:1px solid #999;background:#fafafa"></canvas>
<form method="post" action="/seats"><input type="hidden" name="seat" id="seat">
<p>Selected seat: <b id="sel">none</b></p><p><input type="submit" value="Book seat"></p></form></div>""", head="""<script>
var ROWS='ABCD', TAKEN={'A2':1,'B5':1,'C1':1,'D4':1}, picked=null;
function draw(){var c=document.getElementById('map').getContext('2d');c.clearRect(0,0,460,250);c.font='bold 14px Tahoma';
 for(var r=0;r<4;r++)for(var k=1;k<=6;k++){var id=ROWS[r]+k,x=20+(k-1)*72,y=20+r*56;
  c.fillStyle=TAKEN[id]?'#bbb':(picked==id?'#2e7d32':'#9ccc65');c.fillRect(x,y,56,40);c.fillStyle='#000';c.fillText(id,x+18,y+25);}}
document.addEventListener('DOMContentLoaded',function(){var m=document.getElementById('map');draw();
 m.addEventListener('click',function(e){var b=m.getBoundingClientRect(),x=e.clientX-b.left,y=e.clientY-b.top;
  var k=Math.floor((x-20)/72)+1,r=Math.floor((y-20)/56);if(k<1||k>6||r<0||r>3)return;
  if((x-20)%72>56||(y-20)%56>40)return;var id=ROWS[r]+k;if(TAKEN[id])return;picked=id;
  document.getElementById('seat').value=id;document.getElementById('sel').textContent=id;draw();});});</script>""")


@app.post("/seats", response_class=HTMLResponse)
async def seats_submit(request: Request):
    if r := login_required(request):
        return r
    f = await request.form()
    if not f.get("seat"):
        return doc("Seat Booking", '<div class="box"><h2>Seat Booking</h2><p class="err">Pick a seat on the map first.</p>'
                                   '<p><a href="/seats">Back</a></p></div>')
    STATE["seats"].append(f.get("seat"))
    return doc("Booked", f'<div class="box"><h2>Seat Booking</h2><p class="ok">Seat {html.escape(f.get("seat"))} booked for today.</p></div>')


# ---------------------------------------------------------------- Communication (letters, notes, circulars, e-mails)
# Like many office systems: one long list per box, newest first, 15 per page, and a search box that only finds an
# exact reference number. Hard to find "what did I send to Priya about leave?" - the assistant fixes that.

def _make_comms():
    import random
    rnd = random.Random(7)
    me = "Ravi Kumar (EMP1042)"
    people = ["Priya Sharma", "Anita Desai", "Arjun Mehta", "Priyanka Rao", "Pradeep Singh", "HR Department", "IT Service Desk",
              "Finance Department", "Admin Department", "Travel Desk", "Purchase Section", "Internal Audit"]
    topics = [
        ("HR", "Note", "Leave application for {d1}", "Requesting casual leave on {d1} for a family function. Work is handed over to {p2}."),
        ("HR", "Letter", "Approval of earned leave", "Your earned leave from {d1} to {d2} has been approved by {p}."),
        ("HR", "Circular", "List of holidays for 2027", "The list of public and restricted holidays for the calendar year 2027 is attached."),
        ("HR", "Circular", "Revised attendance policy", "From {d1} biometric attendance is mandatory for all staff. Late marks beyond three per month lead to half-day leave."),
        ("IT", "E-mail", "Laptop replacement request LT-{n4}", "My laptop LT-{n4} has a flickering screen and frequent shutdowns. Requesting a replacement."),
        ("IT", "E-mail", "VPN access for remote work", "Please enable VPN access for {p2} for the period {d1} to {d2}."),
        ("IT", "Circular", "Scheduled maintenance of the e-mail server", "The e-mail server will be down on {d1} from 10:00 pm to 2:00 am for maintenance."),
        ("Purchase", "Note", "Purchase of ergonomic chairs PR-{n4}", "Requesting purchase of {q} ergonomic chairs at INR {amt} each for the Engineering team. Cost centre CC-110."),
        ("Purchase", "Letter", "Approval of purchase order PO-{n4}", "Purchase order PO-{n4} for INR {amt} from {v} has been approved."),
        ("Finance", "Note", "Reimbursement of taxi fare", "Claim for taxi fare of INR {amt} for the client visit on {d1}, project PRJ-{n4}."),
        ("Finance", "Letter", "Budget allocation for Q4", "The Q4 budget for cost centre CC-110 is fixed at INR {big}. Please plan expenditure accordingly."),
        ("Travel", "Note", "Travel request to {city}", "Requesting approval for travel to {city} from {d1} to {d2} for a client visit."),
        ("Travel", "Letter", "Travel advance sanctioned", "A travel advance of INR {amt} has been sanctioned for your visit to {city}."),
        ("Meetings", "E-mail", "Minutes of the sprint planning meeting", "Minutes of the sprint planning held on {d1}: action items assigned to {p2} and {p3}."),
        ("Meetings", "E-mail", "Audit review meeting on {d1}", "The audit review meeting is scheduled on {d1} at 11:00 in the Tulip room. Please confirm attendance."),
        ("Projects", "Note", "Status report for project PRJ-{n4}", "Project PRJ-{n4} is 70% complete. The next milestone is due on {d2}."),
        ("Admin", "Circular", "Fire drill on {d1}", "A fire drill will be held on {d1} at 3:00 pm. All staff must assemble at the parking area."),
        ("Admin", "Letter", "Allotment of desk B3-114", "Desk B3-114 on the 3rd floor is allotted to you from {d1}."),
    ]
    vendors = ["Acme Supplies", "Globex Traders", "Initech Services", "Stark Hardware"]
    cities = ["Pune", "Mumbai", "Delhi", "Chennai", "Hyderabad"]
    from datetime import date as _d, timedelta
    items = []
    for i in range(150):
        cat, typ, subj, body = rnd.choice(topics)
        day = _d(2026, 10, 19) - timedelta(days=rnd.randint(0, 300))
        d1 = (day + timedelta(days=rnd.randint(1, 20))).strftime("%d %b %Y")
        d2 = (day + timedelta(days=rnd.randint(21, 40))).strftime("%d %b %Y")
        p, p2, p3 = rnd.sample(people[:5], 3)
        f = dict(d1=d1, d2=d2, p=p, p2=p2, p3=p3, n4=rnd.randint(1000, 9999), q=rnd.randint(2, 12), amt=f"{rnd.randint(8, 95) * 100:,}",
                 big=f"{rnd.randint(10, 90) * 100000:,}", v=rnd.choice(vendors), city=rnd.choice(cities))
        circular = typ == "Circular"
        outward = not circular and rnd.random() < 0.45
        other = rnd.choice(people) if not circular else rnd.choice(["HR Department", "IT Service Desk", "Admin Department"])
        if subj.startswith("Leave application"):   # Ravi applies to his manager
            outward, other = True, "Priya Sharma"
        items.append({
            "id": 5000 + i, "box": "out" if outward else "in", "type": typ,
            "ref": f"ACME/{cat.upper()[:3]}/{day.year}/{rnd.randint(100, 999):04d}", "date": day.isoformat(),
            "from": me if outward else other, "to": other if outward else ("All staff" if circular else me),
            "cc": rnd.choice(["", "", "Priya Sharma", "HR Department"]),
            "subject": subj.format(**f), "body": body.format(**f),
            "attachments": rnd.choice([[], [], ["scan.pdf"], ["annexure.xlsx"]]),
        })
    items.sort(key=lambda x: x["date"], reverse=True)
    return items


COMMS = _make_comms()


@app.get("/comms", response_class=HTMLResponse)
def comms_list(request: Request, box: str = "in", page: int = 1, ref: str = ""):
    if r := login_required(request):
        return r
    rows = [c for c in COMMS if c["box"] == box and (not ref or c["ref"] == ref.strip())]
    per = 15
    pages = max(1, (len(rows) + per - 1) // per)
    trs = "".join(f"""<tr><td>{c['date']}</td><td>{html.escape(c['ref'])}</td><td>{c['type']}</td>
<td>{html.escape(c['to'] if box == 'out' else c['from'])}</td><td><a href="/comms/{c['id']}">{html.escape(c['subject'])}</a></td></tr>"""
                  for c in rows[(page - 1) * per: page * per])
    pager = " ".join(f'<b>{i}</b>' if i == page else f'<a href="/comms?box={box}&page={i}">{i}</a>' for i in range(1, pages + 1))
    return doc("Communication", f"""<div class="box"><h2>Communication - {'Outward' if box == 'out' else 'Inward'}</h2>
<form method="get" action="/comms"><input type="hidden" name="box" value="{box}">Search by reference no.:
<input name="ref" value="{html.escape(ref)}" size="24"> <input type="submit" value="Go"> <span style="color:#666">(exact reference number only)</span></form>
<table class="grid" style="margin-top:8px"><tr><th>Date</th><th>Reference</th><th>Type</th><th>{'To' if box == 'out' else 'From'}</th><th>Subject</th></tr>{trs}</table>
<p>Page: {pager}</p></div>""")


@app.get("/comms/{cid}", response_class=HTMLResponse)
def comms_item(request: Request, cid: int):
    if r := login_required(request):
        return r
    c = next((x for x in COMMS if x["id"] == cid), None)
    if not c:
        return doc("Not found", '<div class="box"><p class="err">No such communication.</p></div>')
    att = ", ".join(c["attachments"]) or "-"
    return doc(c["subject"], f"""<div class="box"><h2>{html.escape(c['type'])}: {html.escape(c['subject'])}</h2><table class="form">
<tr><td>Reference</td><td>{html.escape(c['ref'])}</td></tr><tr><td>Date</td><td>{c['date']}</td></tr>
<tr><td>From</td><td>{html.escape(c['from'])}</td></tr><tr><td>To</td><td>{html.escape(c['to'])}</td></tr>
<tr><td>Cc</td><td>{html.escape(c['cc'] or '-')}</td></tr><tr><td>Attachments</td><td>{html.escape(att)}</td></tr></table>
<p style="border-top:1px solid #ccc;padding-top:8px">{html.escape(c['body'])}</p>
<p><a href="/comms?box={c['box']}">&laquo; Back to the list</a></p></div>""")


@app.get("/api/comms")
def comms_api(request: Request):
    """The list the app's own pages are built from, for the signed-in user (read by the assistant as the user)."""
    if not user(request):
        return JSONResponse({"error": "not signed in"}, status_code=401)
    base = str(request.base_url).rstrip("/")
    return [{**c, "url": f"{base}/?main=/comms/{c['id']}"} for c in COMMS]


# ---------------------------------------------------------------- test hooks

@app.get("/debug/state")
def debug_state():
    return JSONResponse(STATE)


@app.post("/debug/reset")
def debug_reset():
    STATE.clear()
    STATE.update(fresh_state())
    EPOCH[0] += 1
    return {"ok": True}
