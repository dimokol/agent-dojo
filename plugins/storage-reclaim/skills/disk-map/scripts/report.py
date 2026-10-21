#!/usr/bin/env python3
"""disk-map report: read `dua stacks` output and summarize, render or diff it.

Read-only. Works on any OS with Python 3.8+, no packages needed.

  report.py summary SNAP [--top N]           text report for an agent or a terminal
  report.py html SNAP OUT.html [--title T]   self-contained treemap page (TreeSize-style)
  report.py diff OLD NEW [--depth D] [--top N] [--narrow-old SUB]  what grew and shrank between two scans
  report.py prefixes SNAP [--min BYTES]      every folder in the snapshot with its total, for lookups
  report.py unreadable SNAP                  paths the scan could not read, with their error counts
  report.py convert [--header H] < AGG       turn `dua -f bytes aggregate -d N` output into SNAP format

SNAP is in `dua stacks` format: one line per entry, the path relative to the
scanned root with ';' between segments, then a space and the size in bytes. Lines
at the depth limit carry their whole subtree, so the lines sum to the scan total.
map.sh writes it with `convert`, because `dua stacks` says nothing about folders it
could not read; those go in `#unreadable` comment lines. Sizes print in decimal
units (1 GB = 10^9 bytes); `du -h` uses GiB, so it reads about 7% lower.
"""
import argparse
import html
import json
import os
import re
import sys
from collections import defaultdict

# Folder names that usually hold rebuildable output. A hit means "look here",
# never "safe to delete": that call needs the in-use and last-copy checks.
REGENERABLE = {
    'node_modules': 'JS dependencies',
    '.next': 'build output', '.nuxt': 'build output', 'dist': 'build output',
    'build': 'build output', 'out': 'build output', '.turbo': 'build cache',
    '.parcel-cache': 'build cache', '.vite': 'build cache', 'target': 'Rust/Java build',
    '.gradle': 'Gradle cache', '.cxx': 'native build cache', 'DerivedData': 'Xcode build',
    'Pods': 'CocoaPods', '__pycache__': 'Python bytecode', '.venv': 'Python env',
    'venv': 'Python env', '.tox': 'Python env', '.cache': 'mixed cache, judge each child',
    'Caches': 'app caches', 'Cache': 'app cache', 'Code Cache': 'app cache',
    'GPUCache': 'app cache', 'CachedData': 'app cache', 'worktrees': 'git worktrees',
    '$RECYCLE.BIN': 'Windows recycle bin', 'System Volume Information': 'Windows restore points',
    'Temp': 'temp files', 'tmp': 'temp files', '.Trash': 'macOS trash', '.Trashes': 'macOS trash',
}
# Mixed folders: a more specific name deeper down decides what the entry is.
CONTAINERS = {'Caches', '.cache', 'Temp', 'tmp'}
PROFILE = 'hold logins, not a cache'


def is_profile(seg):
    return seg.startswith('ms-playwright-mcp') or seg.endswith('-profile') or seg == 'User Data'


def classify(p):
    """(index, label key) of the segment that names this entry, or None.

    The first known name wins, except inside a mixed container like Caches, where
    a deeper known name (a browser profile, a Cache folder) is more specific."""
    hit = None
    for i, seg in enumerate(p):
        if is_profile(seg):
            hit = (i, seg)
        elif seg in REGENERABLE:
            hit = (i, seg)
        else:
            continue
        if not (is_profile(seg) or seg in CONTAINERS):
            break
    return hit


def label(seg):
    return PROFILE if is_profile(seg) and seg not in REGENERABLE else REGENERABLE[seg]


def meta(path):
    """The '#disk-map key=value ...' header map.sh writes, or {} for a bare dua file."""
    with open(path, encoding='utf-8', errors='replace') as f:
        first = f.readline()
    if not first.startswith('#disk-map '):
        return {}
    return dict(kv.split('=', 1) for kv in re.findall(r'(\w+=.*?)(?= \w+=|$)', first[10:].strip()))


def unreadable(path):
    """[(count, path tuple)] from the '#unreadable' lines convert writes."""
    out = []
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if line.startswith('#unreadable\t'):
                _, n, p = line.rstrip('\n').split('\t', 2)
                out.append((int(n), tuple(p.split(';'))))
    return sorted(out, key=lambda kv: -kv[0])


def load(path):
    leaves = {}
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.rstrip('\n')
            if not line or line.startswith('#'):
                continue
            name, _, size = line.rpartition(' ')
            if not size.isdigit():
                continue
            leaves[tuple(name.split(';'))] = int(size)
    if not leaves:
        sys.exit(f'{path}: no "path size" lines found; is this `dua stacks` output?')
    return leaves


def fmt(n):
    n = float(n)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if abs(n) < 1000 or unit == 'TB':
            return f'{n:.0f} {unit}' if unit in ('B', 'KB') else f'{n:.1f} {unit}'
        n /= 1000


def at_depth(leaves, depth):
    agg = defaultdict(int)
    for p, s in leaves.items():
        agg[p[:depth]] += s
    return agg


def cmd_summary(a):
    leaves = load(a.snap)
    total = sum(leaves.values())
    print(f'TOTAL {fmt(total)}  ({len(leaves)} entries; 1 GB = 10^9 bytes, du -h shows GiB)')
    bad = unreadable(a.snap)
    if bad:
        print(f'unknown: {sum(n for n, _ in bad)} unreadable paths, size not counted. Most in: '
              + ', '.join(f'{"/".join(p) or "(root)"} ({n})' for n, p in bad[:5]))
    print()
    for depth in (1, 2):
        print(f'== largest at depth {depth}')
        for p, s in sorted(at_depth(leaves, depth).items(), key=lambda kv: -kv[1])[:a.top]:
            print(f'{fmt(s):>10}  {s / total:6.1%}  {"/".join(p)}')
        print()
    print('== largest single entries at the scan depth (a folder here is its whole subtree)')
    for p, s in sorted(leaves.items(), key=lambda kv: -kv[1])[:a.top]:
        print(f'{fmt(s):>10}  {"/".join(p)}')
    hits = defaultdict(int)
    where = defaultdict(list)
    for p, s in leaves.items():
        hit = classify(p)
        if hit:
            i, seg = hit
            key = 'ms-playwright-mcp' if is_profile(seg) and seg not in REGENERABLE else seg
            hits[key] += s
            where[key].append(('/'.join(p[:i + 1]), s))
    if hits:
        print('\n== usually-rebuildable folder names (look, then run the safety checks)')
        for seg, s in sorted(hits.items(), key=lambda kv: -kv[1]):
            if s < total / 1000:
                continue
            spots = defaultdict(int)
            for w, ws in where[seg]:
                spots[w] += ws
            top = sorted(spots.items(), key=lambda kv: -kv[1])[:3]
            name = 'browser profiles' if seg == 'ms-playwright-mcp' else seg
            print(f'{fmt(s):>10}  {name} ({label(seg)}), {len(spots)} place(s); biggest: '
                  + ', '.join(f'{w} {fmt(ws)}' for w, ws in top))


def rebase(leaves, prefix):
    n = len(prefix)
    return {p[n:]: s for p, s in leaves.items() if p[:n] == prefix and len(p) > n}


def cmd_diff(a):
    old, new = load(a.old), load(a.new)
    mo, mn = meta(a.old), meta(a.new)
    for label, m, path in (('old', mo, a.old), ('new', mn, a.new)):
        print(f'{label}: {m.get("when", "?")}  root={m.get("root", "?")}  depth={m.get("depth", "?")}  '
              f'flags={m.get("flags", "?")}  ({os.path.basename(path)})')
    if mo and mn and mo.get('flags') != mn.get('flags'):
        print('WARNING: the scans used different flags; sizes are not directly comparable')
    # A scan of a parent folder can be compared with a scan of one of its subfolders.
    if a.narrow_old:
        old = rebase(old, tuple(a.narrow_old.strip('/').split('/')))
        print(f'(old scan narrowed to {a.narrow_old})')
    if a.narrow_new:
        new = rebase(new, tuple(a.narrow_new.strip('/').split('/')))
        print(f'(new scan narrowed to {a.narrow_new})')
    ro, rn = mo.get('root', ''), mn.get('root', '')
    if not (ro and rn) and not (a.narrow_old or a.narrow_new or a.same_root):
        sys.exit('a scan has no #disk-map header, so its root is unknown and the diff could compare '
                 'different folders. Pass --same-root if both scanned the same folder, or --narrow-old / '
                 '--narrow-new with the subfolder path inside the bigger scan.')
    if ro and rn and ro != rn and not (a.narrow_old or a.narrow_new):
        if rn.startswith(ro.rstrip('/') + '/'):
            pre = tuple(rn[len(ro.rstrip('/')) + 1:].split('/'))
            old = rebase(old, pre)
            print(f'(old scan narrowed to {"/".join(pre)} to match the new root)')
        elif ro.startswith(rn.rstrip('/') + '/'):
            pre = tuple(ro[len(rn.rstrip('/')) + 1:].split('/'))
            new = rebase(new, pre)
            print(f'(new scan narrowed to {"/".join(pre)} to match the old root)')
        else:
            sys.exit('the two scans cover unrelated folders; nothing to compare')
    # Below the shallower scan's depth, paths can't line up: cap the comparison there.
    limit = min(max(len(p) for p in old), max(len(p) for p in new))
    depth = min(a.depth, limit)
    if depth < a.depth:
        print(f'(depth capped at {depth}: the shallower scan goes no deeper)')
    print()
    to, tn = sum(old.values()), sum(new.values())
    print(f'TOTAL {fmt(to)} -> {fmt(tn)}  ({"+" if tn >= to else "-"}{fmt(abs(tn - to))})\n')
    o, n = at_depth(old, depth), at_depth(new, depth)
    delta = {p: n.get(p, 0) - o.get(p, 0) for p in set(o) | set(n)}
    grew = sorted((kv for kv in delta.items() if kv[1] > 0), key=lambda kv: -kv[1])[:a.top]
    shrank = sorted((kv for kv in delta.items() if kv[1] < 0), key=lambda kv: kv[1])[:a.top]
    print(f'== grew (depth {depth})')
    for p, d in grew:
        tag = '  NEW' if p not in o else ''
        print(f'{"+" + fmt(d):>11}  {"/".join(p)}  (now {fmt(n.get(p, 0))}){tag}')
    print(f'\n== shrank (depth {depth})')
    for p, d in shrank:
        tag = '  GONE' if p not in n else ''
        print(f'{"-" + fmt(-d):>11}  {"/".join(p)}{tag}')


def cmd_prefixes(a):
    # Exact totals for every path the snapshot resolves. A path deeper than the scan
    # depth is not listed, so a caller that misses here must measure it itself.
    agg = defaultdict(int)
    for p, s in load(a.snap).items():
        for i in range(1, len(p) + 1):
            agg[p[:i]] += s
    for p, s in agg.items():
        if s >= a.min:
            print(f'{s}\t{"/".join(p)}')


def cmd_unreadable(a):
    for n, p in unreadable(a.snap):
        print(f'{n}\t{"/".join(p)}')


AGG = re.compile(r'^\s*(\d+) b (.*?)(?:  <(\d+) IO Errors?>)?$')


def convert(lines, header=''):
    """`dua -f bytes aggregate --no-total -d N` lines -> snapshot lines.

    dua prints a pre-order tree, two spaces of indent per level after 'b '. Leaves
    carry their subtree, so they sum to the total like `dua stacks`. dua counts IO
    errors up the tree; a folder's own share is its count minus its children's."""
    out, bad, errs = [], [], 0
    open_ = []  # [level, path, size, errors, children's errors, has children]

    def close(node):
        level, p, size, n, kid_n, kids = node
        if n - kid_n > 0:
            bad.append((n - kid_n, p))
        if not kids and size > 0:
            out.append(f'{";".join(p)} {size}')
    for line in lines:
        m = AGG.match(line.rstrip('\n'))
        if not m:
            continue
        rest = m.group(2)
        level = (len(rest) - len(rest.lstrip(' '))) // 2
        while open_ and open_[-1][0] >= level:
            close(open_.pop())
        n = int(m.group(3) or 0)
        if open_:
            open_[-1][4] += n
            open_[-1][5] = True
        else:
            errs += n
        p = (open_[-1][1] if open_ else ()) + (rest[2 * level:],)
        open_.append([level, p, int(m.group(1)), n, 0, False])
    while open_:
        close(open_.pop())
    head = [f'#disk-map {header.strip()} unreadable={errs}'] if header else []
    return head + [f'#unreadable\t{n}\t{";".join(p)}' for n, p in bad] + out


def cmd_convert(a):
    for line in convert(sys.stdin, a.header or ''):
        print(line)


def build_tree(leaves, total):
    root = {'n': '', 's': 0, 'c': {}}
    for p, s in leaves.items():
        node = root
        node['s'] += s
        for seg in p:
            node = node['c'].setdefault(seg, {'n': seg, 's': 0, 'c': {}})
            node['s'] += s
    floor = total / 20000  # merge slivers so the page stays small

    def pack(node):
        kids = sorted(node['c'].values(), key=lambda k: -k['s'])
        keep = [pack(k) for k in kids if k['s'] >= floor]
        rest = sum(k['s'] for k in kids if k['s'] < floor)
        if rest:
            keep.append({'n': '(smaller items)', 's': rest})
        out = {'n': node['n'], 's': node['s']}
        if keep:
            out['c'] = keep
        return out
    return pack(root)


PAGE = r'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>__TITLE__</title>
<style>
:root{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--rule:#e4e3df;--other:#b9b8b2;
--c1:#2a78d6;--c2:#eb6834;--c3:#1baf7a;--c4:#eda100;--c5:#e87ba4;--c6:#008300;--c7:#6250d6;--c8:#e34948}
@media (prefers-color-scheme:dark){:root{--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--rule:#383835;--other:#5c5b57;
--c1:#3987e5;--c2:#d95926;--c3:#199e70;--c4:#c98500;--c5:#d55181;--c6:#008300;--c7:#9085e9;--c8:#e66767}}
body{margin:0;font:14px/1.4 system-ui,sans-serif;background:var(--surface);color:var(--ink)}
header{padding:16px 20px 8px}h1{font-size:18px;margin:0 0 4px}.sub{color:var(--ink2)}
#crumbs{padding:4px 20px;color:var(--ink2)}#crumbs a{color:var(--ink);cursor:pointer;text-decoration:underline}
#map{position:relative;margin:8px 20px;height:62vh;min-height:360px}
.t{position:absolute;box-sizing:border-box;border:1px solid var(--surface);border-radius:3px;overflow:hidden;
font-size:12px;color:#fff}
.t.open{cursor:pointer}.lbl{position:absolute;left:5px;right:4px;top:2px;white-space:nowrap;overflow:hidden;
text-overflow:ellipsis;pointer-events:none}.lbl b{font-weight:600}.lbl span{opacity:.9;margin-left:6px}
.t .t{border-color:rgba(255,255,255,.35);background:rgba(0,0,0,.08);color:inherit}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--surface);padding:6px 8px;border-radius:4px;
font-size:12px;display:none;max-width:420px;z-index:9}
table{border-collapse:collapse;margin:8px 20px 32px;min-width:min(720px,90vw)}
td,th{padding:4px 10px;border-bottom:1px solid var(--rule);text-align:left}td.r,th.r{text-align:right}
tr.open{cursor:pointer}tr.open:hover td,tr.open:focus td{background:var(--rule)}tr.open:focus{outline:2px solid var(--ink)}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:baseline}
</style></head><body>
<header><h1>__TITLE__</h1><div class="sub">__SUB__</div></header>
<div id="crumbs"></div><div id="map" role="img" aria-label="Treemap of disk usage; the table below lists the same data"></div>
<div id="tip"></div><table id="tbl"></table>
<script>
const DATA=__DATA__;
const COLORS=['--c1','--c2','--c3','--c4','--c5','--c6','--c7','--c8'];
const fmt=n=>{const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1000&&i<4){n/=1000;i++}return (i<2?n.toFixed(0):n.toFixed(1))+' '+u[i]};
let path=[DATA];
function squarify(items,x,y,w,h,out){
  // Bruls et al. squarified treemap: lay rows along the short side, keep aspect ratios near 1.
  items=items.filter(d=>d.s>0);const sum=items.reduce((a,d)=>a+d.s,0);if(!sum)return;
  const scale=w*h/sum;let rest=items.map(d=>({d,a:d.s*scale}));
  while(rest.length){const side=Math.min(w,h);let row=[],best=Infinity;
    for(const it of rest){const r=row.concat(it),s=r.reduce((a,b)=>a+b.a,0),
      worst=Math.max(...r.map(z=>Math.max(side*side*z.a/(s*s),s*s/(side*side*z.a))));
      if(worst>best)break;best=worst;row=r}
    const s=row.reduce((a,b)=>a+b.a,0),thick=s/side;let off=0;
    for(const z of row){const len=z.a/thick;
      out.push(w>=h?{d:z.d,x:x,y:y+off,w:thick,h:len}:{d:z.d,x:x+off,y:y,w:len,h:thick});off+=len}
    if(w>=h){x+=thick;w-=thick}else{y+=thick;h-=thick}rest=rest.slice(row.length)}}
const HEAD=18;
// Colour follows the folders of the current view (largest first), so each tile is
// one identity; the folders inside it are drawn nested, a second level deep.
// Label text: white or near-black, whichever contrasts more with the tile (WCAG luminance).
function ink(bg){const m=/var\((--[\w-]+)\)/.exec(bg||'');if(!m)return '';
  const hex=getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim().replace('#','');
  const [r,g,b]=[0,2,4].map(i=>{const c=parseInt(hex.slice(i,i+2),16)/255;return c<=.03928?c/12.92:((c+.055)/1.055)**2.4});
  const L=.2126*r+.7152*g+.0722*b;return 1.05/(L+.05)>=(L+.05)/.0537?'#fff':'#0b0b0b'}
function colours(node){const m=new Map();(node.c||[]).forEach((k,i)=>m.set(k,i<8&&k.n!=='(smaller items)'?`var(${COLORS[i]})`:'var(--other)'));return m}
function tile(parent,d,x,y,w,h,bg,view,depth){
  const el=document.createElement('div');el.className='t'+(d.c?' open':'');
  el.style.cssText=`left:${x}px;top:${y}px;width:${w}px;height:${h}px`+(bg?`;background:${bg};color:${ink(bg)}`:'');
  if(w>56&&h>16)el.innerHTML=`<div class="lbl"><b>${esc(d.n)}</b>${w>110?`<span>${fmt(d.s)}</span>`:''}</div>`;
  el.onmousemove=e=>{e.stopPropagation();tip(e,d,view,depth)};el.onmouseleave=()=>tipEl.style.display='none';
  if(d.c)el.onclick=e=>{e.stopPropagation();open(...(depth?[view,d]:[d]))};
  parent.appendChild(el);return el}
function open(...nodes){path.push(...nodes);tipEl.style.display='none';render()}
function render(){
  const node=path[path.length-1],map=document.getElementById('map');map.innerHTML='';
  const R=map.getBoundingClientRect(),cells=[],hue=colours(node);
  squarify(node.c||[],0,0,R.width,R.height,cells);
  for(const c of cells){const el=tile(map,c.d,c.x,c.y,c.w,c.h,hue.get(c.d),node,0);
    if(c.d.c&&c.w>60&&c.h>50){const inner=[];
      squarify(c.d.c,0,0,c.w-6,c.h-HEAD-4,inner);
      for(const g of inner)tile(el,g.d,g.x+2,g.y+HEAD,g.w,g.h,null,c.d,1)}}
  document.getElementById('crumbs').innerHTML=path.map((p,i)=>i<path.length-1?
    `<a data-i="${i}">${esc(i?p.n:'(root)')}</a>`:`<b>${esc(i?p.n:'(root)')}</b>`).join(' / ')+` <span>${fmt(node.s)}</span>`;
  document.querySelectorAll('#crumbs a').forEach(a=>a.onclick=()=>{path=path.slice(0,+a.dataset.i+1);render()});
  const rows=(node.c||[]).map((k,i)=>`<tr${k.c?` class="open" tabindex="0" data-k="${i}"`:''}><td><span class="sw" style="background:${hue.get(k)}"></span>${esc(k.n)}${k.c?' ›':''}</td>
    <td class="r">${fmt(k.s)}</td><td class="r">${(100*k.s/node.s).toFixed(1)}%</td></tr>`).join('');
  document.getElementById('tbl').innerHTML=`<tr><th>Name</th><th class="r">Size</th><th class="r">Share</th></tr>`+rows;
  document.querySelectorAll('#tbl tr.open').forEach(tr=>{const k=node.c[+tr.dataset.k];
    tr.onclick=()=>open(k);tr.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();open(k)}}})}
const tipEl=document.getElementById('tip');
function tip(e,d,parent,depth){const full=path.slice(1).map(p=>p.n).concat(depth?[parent.n]:[]).concat(d.n).join('/');
  tipEl.innerHTML=`<b>${esc(full)}</b><br>${fmt(d.s)}, ${(100*d.s/parent.s).toFixed(1)}% of ${depth?esc(parent.n):'this view'}, ${(100*d.s/DATA.s).toFixed(1)}% of the scan${d.c?'<br>click to open':''}`;
  tipEl.style.display='block';tipEl.style.left=Math.min(e.clientX+14,innerWidth-440)+'px';tipEl.style.top=(e.clientY+14)+'px'}
function esc(s){return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
addEventListener('resize',render);render();
</script></body></html>'''


def cmd_html(a):
    leaves = load(a.snap)
    total = sum(leaves.values())
    tree = build_tree(leaves, total)
    title = a.title or 'Disk map'
    bad = unreadable(a.snap)
    sub = f'{fmt(total)} scanned (1 GB = 10^9 bytes).'
    if bad:
        sub += (f' Unknown: {sum(n for n, _ in bad)} unreadable paths, size not counted, most in '
                + ', '.join(f'{"/".join(p) or "(root)"} ({n})' for n, p in bad[:3]) + '.')
    sub += ' Click a tile or a row to open it, use the path above to go back.'
    page = (PAGE.replace('__TITLE__', html.escape(title)).replace('__SUB__', html.escape(sub))
            .replace('__DATA__', json.dumps(tree, separators=(',', ':')).replace('</', '<\\/')))
    with open(a.out, 'w', encoding='utf-8') as f:
        f.write(page)
    print(f'wrote {a.out} ({fmt(len(page))})')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest='cmd', required=True)
    s = sp.add_parser('summary'); s.add_argument('snap'); s.add_argument('--top', type=int, default=15)
    s.set_defaults(fn=cmd_summary)
    h = sp.add_parser('html'); h.add_argument('snap'); h.add_argument('out'); h.add_argument('--title')
    h.set_defaults(fn=cmd_html)
    d = sp.add_parser('diff'); d.add_argument('old'); d.add_argument('new')
    d.add_argument('--depth', type=int, default=3); d.add_argument('--top', type=int, default=15)
    d.add_argument('--narrow-old', help='compare only this subfolder of the old scan, e.g. Documents/projects')
    d.add_argument('--narrow-new', help='compare only this subfolder of the new scan')
    d.add_argument('--same-root', action='store_true', help='a headerless scan covers the same folder as the other')
    d.set_defaults(fn=cmd_diff)
    x = sp.add_parser('prefixes'); x.add_argument('snap'); x.add_argument('--min', type=int, default=0)
    x.set_defaults(fn=cmd_prefixes)
    u = sp.add_parser('unreadable'); u.add_argument('snap'); u.set_defaults(fn=cmd_unreadable)
    c = sp.add_parser('convert'); c.add_argument('--header', help='key=value pairs for the #disk-map line')
    c.set_defaults(fn=cmd_convert)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
