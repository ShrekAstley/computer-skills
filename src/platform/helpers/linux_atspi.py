#!/usr/bin/env python3
"""AT-SPI accessibility bridge for computer-skills (Linux).

Reads one JSON request on stdin, writes one JSON response on stdout.
Requests: {"op": "tree"|"find"|"action"|"apps", ...}
Element refs are index paths from the desktop root, e.g. [3, 0, 2, 5].
"""
import json
import sys


def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as exc:  # pragma: no cover - environment dependent
    out({"ok": False, "error": "atspi-unavailable", "message": str(exc)})
    sys.exit(0)

STATE_NAMES = {
    "focused": Atspi.StateType.FOCUSED,
    "enabled": Atspi.StateType.ENABLED,
    "sensitive": Atspi.StateType.SENSITIVE,
    "showing": Atspi.StateType.SHOWING,
    "visible": Atspi.StateType.VISIBLE,
    "checked": Atspi.StateType.CHECKED,
    "selected": Atspi.StateType.SELECTED,
    "expanded": Atspi.StateType.EXPANDED,
    "editable": Atspi.StateType.EDITABLE,
    "active": Atspi.StateType.ACTIVE,
}


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def describe(acc, path, with_text=True):
    node = {
        "path": path,
        "role": safe(acc.get_role_name, "") or "",
        "name": safe(acc.get_name, "") or "",
    }
    desc = safe(acc.get_description, "")
    if desc:
        node["description"] = desc
    ext = safe(lambda: acc.get_extents(Atspi.CoordType.SCREEN))
    if ext is not None:
        node.update({"x": ext.x, "y": ext.y, "width": ext.width, "height": ext.height})
    states = safe(acc.get_state_set)
    if states is not None:
        node["states"] = [n for n, s in STATE_NAMES.items() if states.contains(s)]
    action = safe(acc.get_action_iface)
    if action is not None:
        n = safe(action.get_n_actions, 0) or 0
        node["actions"] = [safe(lambda i=i: action.get_action_name(i), "") for i in range(min(n, 8))]
    if with_text:
        text = safe(acc.get_text_iface)
        if text is not None:
            cnt = safe(text.get_character_count, 0) or 0
            if cnt:
                node["value"] = safe(lambda: text.get_text(0, min(cnt, 500)), "")
        val = safe(acc.get_value_iface)
        if val is not None:
            node["value"] = safe(val.get_current_value)
    return node


def resolve(path):
    acc = Atspi.get_desktop(0)
    for idx in path:
        acc = acc.get_child_at_index(idx)
        if acc is None:
            raise LookupError("element no longer exists at path %s" % path)
    return acc


def find_apps(req):
    desktop = Atspi.get_desktop(0)
    apps = []
    for i in range(safe(desktop.get_child_count, 0) or 0):
        app = safe(lambda i=i: desktop.get_child_at_index(i))
        if app is None:
            continue
        apps.append((i, app))
    pid = req.get("pid")
    name = (req.get("app") or "").lower()
    if pid:
        pids = set(req.get("pids") or [pid])
        matched = [(i, a) for i, a in apps if safe(a.get_process_id) in pids]
        if matched:
            return matched
    if name:
        return [(i, a) for i, a in apps if name in (safe(a.get_name, "") or "").lower()]
    return apps


def walk(acc, path, depth, max_depth, budget, only_visible):
    node = describe(acc, path)
    budget[0] -= 1
    if depth >= max_depth or budget[0] <= 0:
        cnt = safe(acc.get_child_count, 0) or 0
        if cnt:
            node["childCount"] = cnt
        return node
    children = []
    for i in range(min(safe(acc.get_child_count, 0) or 0, 400)):
        if budget[0] <= 0:
            break
        child = safe(lambda i=i: acc.get_child_at_index(i))
        if child is None:
            continue
        if only_visible:
            st = safe(child.get_state_set)
            if st is not None and not st.contains(Atspi.StateType.SHOWING):
                continue
        children.append(walk(child, path + [i], depth + 1, max_depth, budget, only_visible))
    if children:
        node["children"] = children
    return node


def op_tree(req):
    budget = [int(req.get("maxNodes", 400))]
    max_depth = int(req.get("depth", 8))
    only_visible = req.get("onlyVisible", True)
    title = (req.get("windowTitle") or "").lower()
    roots = []
    for i, app in find_apps(req):
        if title:
            for w in range(safe(app.get_child_count, 0) or 0):
                win = safe(lambda w=w: app.get_child_at_index(w))
                if win is not None and title in (safe(win.get_name, "") or "").lower():
                    roots.append(walk(win, [i, w], 0, max_depth, budget, only_visible))
        else:
            roots.append(walk(app, [i], 0, max_depth, budget, only_visible))
        if budget[0] <= 0:
            break
    return {"ok": True, "nodes": roots, "truncated": budget[0] <= 0}


def op_find(req):
    name = (req.get("name") or "").lower()
    role = (req.get("role") or "").lower()
    limit = int(req.get("limit", 20))
    budget = [int(req.get("maxNodes", 3000))]
    results = []

    def visit(acc, path, depth):
        if budget[0] <= 0 or len(results) >= limit or depth > 30:
            return
        budget[0] -= 1
        n = (safe(acc.get_name, "") or "")
        r = (safe(acc.get_role_name, "") or "")
        if (not name or name in n.lower()) and (not role or role in r.lower()) and (name or role):
            st = safe(acc.get_state_set)
            if st is None or st.contains(Atspi.StateType.SHOWING):
                results.append(describe(acc, path, with_text=False))
        for i in range(min(safe(acc.get_child_count, 0) or 0, 400)):
            child = safe(lambda i=i: acc.get_child_at_index(i))
            if child is not None:
                visit(child, path + [i], depth + 1)

    for i, app in find_apps(req):
        visit(app, [i], 0)
    return {"ok": True, "nodes": results, "truncated": budget[0] <= 0}


def op_action(req):
    acc = resolve(req["path"])
    action = req.get("action", "press")
    if action in ("press", "invoke", "click", "activate", "toggle", "expand", "collapse", "select"):
        iface = acc.get_action_iface()
        if iface is None:
            if action == "select":
                sel = safe(lambda: acc.get_parent().get_selection_iface())
                if sel is not None:
                    sel.select_child(acc.get_index_in_parent())
                    return {"ok": True}
            raise RuntimeError("element has no actions")
        names = [iface.get_action_name(i) for i in range(iface.get_n_actions())]
        prefer = {
            "press": ["press", "click", "activate", "jump"],
            "invoke": ["press", "click", "activate", "jump"],
            "click": ["click", "press", "activate"],
            "activate": ["activate", "press", "click"],
            "toggle": ["toggle", "click", "press"],
            "expand": ["expand or contract", "expand", "open", "click"],
            "collapse": ["expand or contract", "collapse", "click"],
            "select": ["select", "click", "press"],
        }[action]
        idx = 0
        for p in prefer:
            if p in names:
                idx = names.index(p)
                break
        iface.do_action(idx)
        return {"ok": True, "performed": names[idx] if names else None}
    if action == "focus":
        comp = acc.get_component_iface()
        if comp is None or not comp.grab_focus():
            raise RuntimeError("could not focus element")
        return {"ok": True}
    if action == "set_value":
        value = req.get("value", "")
        et = acc.get_editable_text_iface()
        if et is not None:
            et.set_text_contents(str(value))
            return {"ok": True}
        vi = acc.get_value_iface()
        if vi is not None:
            vi.set_current_value(float(value))
            return {"ok": True}
        raise RuntimeError("element is not editable")
    raise ValueError("unknown action %s" % action)


def op_apps(_req):
    desktop = Atspi.get_desktop(0)
    apps = []
    for i in range(safe(desktop.get_child_count, 0) or 0):
        app = safe(lambda i=i: desktop.get_child_at_index(i))
        if app is not None:
            apps.append({"index": i, "name": safe(app.get_name, ""), "pid": safe(app.get_process_id)})
    return {"ok": True, "apps": apps}


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
        op = req.get("op")
        handler = {"tree": op_tree, "find": op_find, "action": op_action, "apps": op_apps}.get(op)
        if handler is None:
            out({"ok": False, "error": "bad-op", "message": "unknown op %r" % op})
            return
        out(handler(req))
    except Exception as exc:
        out({"ok": False, "error": type(exc).__name__, "message": str(exc)})


if __name__ == "__main__":
    main()
