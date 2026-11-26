"""Move legacy dark-palette Tailwind classes to the redesign tokens (docs/UI_REDESIGN_BRIEF.md).
Usage: python codemod.py file1.tsx file2.tsx ...   (rewrites in place, prints a count per file)"""
import re, sys

PREFIX = r'((?:(?:sm|md|lg|xl|hover|focus|active|disabled|group-hover|focus-within|focus-visible|placeholder|open|checked|first|last):)*)'
START = r'(?<![\w:/\-\[])'
END = r'(?![\w\-/])'
OPAC = r'(?:/(\d+))?'

SOLID_BG = re.compile(r'(?<![\w:/-])(?:hover:)?bg-(?:sky-(?:500|600|700)|emerald-(?:500|600)|rose-(?:500|600|700)|amber-600|purple-(?:500|600)|violet-(?:500|600)|indigo-600)(?![\w/-])|from-(?:sky|emerald|purple|violet|blue)-')
INPUT_LINE = re.compile(r'outline-none|focus:border|<input|<select|<textarea')
BUTTON_LINE = re.compile(r'(?<![\w-])py-(?:1|1\.5|2|2\.5)(?![\w.])')

HUES = {
    'sky': 'brand', 'blue': 'brand', 'emerald': 'success', 'green': 'success', 'amber': 'warning', 'yellow': 'warning',
    'rose': 'danger', 'red': 'danger', 'purple': 'brand', 'violet': 'brand', 'indigo': 'brand',
}

def slate(prop, shade):
    s = int(shade)
    if prop == 'text' or prop == 'placeholder':
        if s <= 300 or s >= 900: return 'fg'
        if s == 400: return 'fg-muted'
        return 'fg-subtle'
    if prop in ('border', 'divide', 'ring', 'outline'):
        if s >= 900: return 'border'
        if s == 800: return 'border'
        return 'border-strong'
    # bg / from / to / fill / stroke
    if s >= 950: return 'canvas'
    if s == 900: return 'surface'
    if s == 800: return 'surface-muted'
    if s == 700: return 'border'
    if s == 600: return 'border-strong'
    if s <= 200: return 'fg'
    return 'fg-subtle'

def hue(prop, h, shade, opac):
    base = HUES[h]
    s = int(shade)
    soft = f'{base}-soft'
    if prop == 'bg':
        if s >= 900: return soft, None
        if opac is not None and int(opac) <= 20: return soft, None
        if base == 'brand': return ('brand-hover' if s >= 700 else 'brand'), opac
        if base == 'success': return 'success', opac
        return f'{base}-solid', opac
    if prop == 'text':
        if base == 'brand': return ('brand-ink' if s <= 200 or h in ('purple', 'violet', 'indigo') else 'brand'), None
        return base, None
    if prop in ('border', 'divide', 'ring', 'outline'):
        if base == 'brand': return 'brand', opac
        return base, opac
    return base, opac

TOKEN = re.compile(START + PREFIX + r'(bg|text|border|divide|ring|outline|placeholder|fill|stroke)-(slate|gray|zinc|white|sky|blue|emerald|green|amber|yellow|rose|red|purple|violet|indigo)(?:-(\d{2,3}))?' + OPAC + END)

def map_line(line):
    solid = bool(SOLID_BG.search(line))
    is_input = bool(INPUT_LINE.search(line))
    is_button = bool(BUTTON_LINE.search(line))

    def repl(m):
        pre, prop, color, shade, opac = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        if color == 'white':
            if shade: return m.group(0)
            if prop == 'text':
                return pre + ('text-on-brand' if solid else 'text-fg')
            if prop == 'bg':
                return pre + 'bg-surface' + (f'/{opac}' if opac else '')
            return pre + f'{prop}-border'
        if shade is None:
            return m.group(0)
        if color in ('slate', 'gray', 'zinc'):
            # an input sits on white, not on the canvas grey
            if prop == 'bg' and int(shade) >= 950 and is_input and not pre:
                return 'bg-surface'
            tok = slate(prop, shade)
            # hover on a secondary (slate-800) button goes one step darker
            if prop == 'bg' and 'hover:' in pre and int(shade) == 700:
                tok = 'border'
            out = f'{pre}{prop}-{tok}'
            return out + (f'/{opac}' if opac and tok not in ('fg', 'fg-muted', 'fg-subtle') else '')
        tok, keep = hue(prop, color, shade, opac)
        # hover:bg-sky-500 on a bg-sky-600 button: darker, not lighter
        if prop == 'bg' and 'hover:' in pre and tok in ('brand',) and int(shade) == 500:
            tok = 'brand-hover'
        if prop == 'bg' and 'hover:' in pre and tok == 'success' and int(shade) == 500:
            return f'{pre}bg-success/90'
        if prop == 'bg' and 'hover:' in pre and tok == 'danger-solid' and int(shade) == 500:
            tok = 'danger'
        return f'{pre}{prop}-{tok}' + (f'/{keep}' if keep else '')

    line = TOKEN.sub(repl, line)
    # gradients become a flat brand fill
    line = re.sub(START + r'bg-gradient-to-(?:r|l|t|b|br|bl|tr|tl)' + END, '', line)
    line = re.sub(START + r'from-(?:sky|blue|indigo)-\d{2,3}' + OPAC + END, 'bg-brand', line)
    line = re.sub(START + r'from-(?:emerald|green)-\d{2,3}' + OPAC + END, 'bg-success', line)
    line = re.sub(START + r'from-(?:purple|violet)-\d{2,3}' + OPAC + END, 'bg-brand', line)
    line = re.sub(START + r'from-(?:amber)-\d{2,3}' + OPAC + END, 'bg-warning-solid', line)
    line = re.sub(START + r'(?:to|via)-[a-z]+-\d{2,3}' + OPAC + END, '', line)
    # no coloured glow shadows
    line = re.sub(START + r'shadow-[a-z]+-\d{2,3}' + OPAC + END, '', line)
    line = re.sub(START + PREFIX + r'shadow-(?:sm|md|lg|xl|2xl)' + END, lambda m: m.group(1) + 'shadow-card', line)
    # radius: 8 buttons and inputs, 12 cards, 16 dialogs
    if is_button or is_input:
        line = re.sub(START + r'rounded-xl' + END, 'rounded-lg', line)
    line = re.sub(START + r'rounded-2xl' + END, 'rounded-xl', line)
    line = re.sub(START + r'rounded-3xl' + END, 'rounded-2xl', line)
    # sentence case, calmer weights, no tiny text
    line = re.sub(r' ?(?<![\w-])uppercase tracking-wider(?![\w-])', '', line)
    line = re.sub(r' ?(?<![\w-])uppercase tracking-wide(?![\w-])', '', line)
    line = re.sub(r' ?(?<![\w-])tracking-wider uppercase(?![\w-])', '', line)
    line = re.sub(START + r'text-\[(?:9|10|11)px\]' + END, 'text-xs', line)
    line = re.sub(START + r'font-(?:black|extrabold|bold)' + END, 'font-semibold', line)
    line = re.sub(START + r'focus:border-(?:brand|success|danger|warning)' + END, 'focus:border-brand', line)
    # tidy double spaces left inside class strings
    line = re.sub(r'(className=(?:"|\{`|\'))\s+', r'\1', line)
    line = re.sub(r'(?<=\S)  +(?=\S)', ' ', line) if 'className' in line or "'" in line else line
    return line

def run(path):
    src = open(path, encoding='utf-8').read()
    out = '\n'.join(map_line(l) for l in src.split('\n'))
    if out != src:
        open(path, 'w', encoding='utf-8').write(out)
    return sum(1 for a, b in zip(src.split('\n'), out.split('\n')) if a != b)

if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(f'{run(p):4d}  {p}')
