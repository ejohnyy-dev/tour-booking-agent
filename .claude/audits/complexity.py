#!/usr/bin/env python3
import re, sys, os

SOURCE_FILES = sys.argv[1:]
FUNC_LINE_THRESHOLD = 60
NEST_THRESHOLD = 4
FILE_LINE_THRESHOLD = 400

offenders = []

def indent_depth(line, tab_width=2):
    stripped = line.lstrip(' \t')
    if not stripped:
        return None
    leading = line[:len(line)-len(stripped)]
    spaces = leading.replace('\t', ' ' * tab_width)
    return len(spaces) // tab_width

func_re = re.compile(r'^\s*(async\s+)?function\s+([A-Za-z0-9_$]+)|^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(|^\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{')

for path in SOURCE_FILES:
    with open(path, 'r', errors='replace') as f:
        lines = f.readlines()
    n = len(lines)
    if n > FILE_LINE_THRESHOLD:
        offenders.append((n, f"{path}:1", f"file is {n} lines (> {FILE_LINE_THRESHOLD})"))

    # brace-based function span + nesting
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.search(r'(async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(', line)
        m2 = re.search(r'\b([A-Za-z0-9_$]+)\s*=\s*(async\s*)?\([^)]*\)\s*=>\s*\{', line)
        name = None
        if m:
            name = m.group(2)
        elif m2:
            name = m2.group(1)
        if name and '{' in ''.join(lines[i:i+3]):
            # find opening brace from this line forward
            depth = 0
            started = False
            start = i
            max_nest = 0
            cur_nest = 0
            j = i
            while j < len(lines):
                for ch in lines[j]:
                    if ch == '{':
                        depth += 1; started = True; cur_nest += 1
                        max_nest = max(max_nest, cur_nest)
                    elif ch == '}':
                        depth -= 1; cur_nest = max(0, cur_nest-1)
                if started and depth == 0:
                    break
                j += 1
            length = j - start + 1
            # nesting relative to function body (subtract 1 for function's own brace)
            body_nest = max_nest - 1
            if length > FUNC_LINE_THRESHOLD:
                offenders.append((length, f"{path}:{start+1}", f"function '{name}' is {length} lines (> {FUNC_LINE_THRESHOLD})"))
            if body_nest > NEST_THRESHOLD:
                offenders.append((100+body_nest, f"{path}:{start+1}", f"function '{name}' nesting depth {body_nest} (> {NEST_THRESHOLD})"))
            i = j + 1
            continue
        i += 1

offenders.sort(key=lambda x: -x[0])
for score, loc, msg in offenders[:20]:
    print(f"{loc} — {msg}")
