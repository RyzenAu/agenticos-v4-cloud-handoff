# Resource sampler run INSIDE the WSL distro by scripts/computers/journey3.ts (stdin to `python3 - name1 name2`).
# Prints one JSON line: per computer and role, process count, PSS (kB, reported under the key rssKb) and cumulative CPU ticks; plus the whole VM's memory and CPU ticks.
# Reads /proc only. Roles come from each computer's own pid files and the process tree below them, never from a guessed name.
import json, os, sys, time

names = sys.argv[1:]
base = os.path.expanduser(os.environ.get("MU_SAMPLER_BASE", "~/mu-computers-a"))
procs = {}
for d in os.listdir("/proc"):
    if not d.isdigit():
        continue
    try:
        with open("/proc/%s/stat" % d) as f:
            s = f.read()
        rest = s[s.rindex(")") + 2:].split()
        ppid = int(rest[1])
        ticks = int(rest[11]) + int(rest[12])
        with open("/proc/%s/statm" % d) as f:
            rss = int(f.read().split()[1]) * 4
        with open("/proc/%s/cmdline" % d, "rb") as f:
            cmd = f.read().replace(b"\0", b" ").decode("utf8", "replace")
        procs[int(d)] = (ppid, ticks, rss, cmd)
    except Exception:
        pass
kids = {}
for pid, v in procs.items():
    kids.setdefault(v[0], []).append(pid)


def tree(root):
    out, stack = [], [root]
    while stack:
        p = stack.pop()
        if p in procs:
            out.append(p)
            stack.extend(kids.get(p, []))
    return out


def pidfile(name, what):
    try:
        return int(open("%s/%s/run/%s.pid" % (base, name, what)).read().split()[0])
    except Exception:
        return None


def pss_kb(pid, fallback):
    # Proportional set size: shared pages (Chromium's zygote/renderers share a lot) are split between their users, so the sum is honest.
    try:
        for line in open("/proc/%d/smaps_rollup" % pid):
            if line.startswith("Pss:"):
                return int(line.split()[1])
    except Exception:
        pass
    return fallback


def is_browser(cmd):
    return "chrom" in cmd.lower()


res = {}
for n in names:
    roles = {"companion": [0, 0, 0], "xvfb": [0, 0, 0], "vnc": [0, 0, 0], "chromium": [0, 0, 0]}
    claimed = set()
    for role in ("companion", "xvfb", "vnc"):
        p = pidfile(n, role)
        if p and p in procs:
            for q in tree(p):
                if q in claimed:
                    continue
                claimed.add(q)
                target = "chromium" if (role == "companion" and is_browser(procs[q][3])) else role
                r = roles[target]
                r[0] += 1
                r[1] += pss_kb(q, procs[q][2])
                r[2] += procs[q][1]
    # A browser that is not below the companion any more but still runs on this computer's own profile.
    prof = "--user-data-dir=%s/%s/profile" % (base, n)
    for q, v in list(procs.items()):
        if prof in v[3] and q not in claimed:
            for z in tree(q):
                if z in claimed:
                    continue
                claimed.add(z)
                r = roles["chromium"]
                r[0] += 1
                r[1] += pss_kb(z, procs[z][2])
                r[2] += procs[z][1]
    res[n] = {k: {"procs": v[0], "rssKb": v[1], "ticks": v[2]} for k, v in roles.items() if v[0]}
mem = {}
for line in open("/proc/meminfo"):
    k, v = line.split(":", 1)
    mem[k] = int(v.split()[0])
cpu = [int(x) for x in open("/proc/stat").readline().split()[1:]]
print(json.dumps({"t": time.time(), "computers": res, "vm": {"memTotalKb": mem["MemTotal"], "memUsedKb": mem["MemTotal"] - mem["MemAvailable"], "cpuBusy": sum(cpu) - cpu[3] - cpu[4], "cpuTotal": sum(cpu)}}))
