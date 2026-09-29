"""Thin PowerPoint COM helpers (16:9, 960 x 540 pt). Fonts: Cambria titles, Calibri body."""
import pathlib
from common import INK, TEAL, TEAL_LIGHT, SLATE, MIST, LINE, AMBER, WHITE, RENDERS, rgb

W, H = 960, 540
M = 48  # outer margin (0.67 in)


class Deck:
    def __init__(self):
        import win32com.client as win32
        self.app = win32.DispatchEx("PowerPoint.Application")
        self.pres = self.app.Presentations.Add(0)
        self.pres.PageSetup.SlideWidth = W
        self.pres.PageSetup.SlideHeight = H
        self.n = 0

    # -- slides ---------------------------------------------------------------
    def slide(self, dark=False, notes="", hidden=False, footer=None):
        self.n += 1
        s = self.pres.Slides.Add(self.n, 12)
        s.FollowMasterBackground = 0
        s.Background.Fill.Solid()
        s.Background.Fill.ForeColor.RGB = rgb(INK if dark else WHITE)
        if notes:
            s.NotesPage.Shapes.Placeholders(2).TextFrame.TextRange.Text = notes
        if hidden:
            s.SlideShowTransition.Hidden = -1
        if footer is not False:
            self.text(s, M, H - 30, W - 2 * M, 16, footer or f"M&U Ventures · {self.n}", 9, colour=("94A3B8" if dark else SLATE))
        return s

    # -- primitives -----------------------------------------------------------
    def text(self, s, x, y, w, h, text, size=16, bold=False, colour=INK, font="Calibri", align=1, italic=False, bullets=False, space_after=4, valign=None):
        shp = s.Shapes.AddTextbox(1, x, y, w, h)
        tf = shp.TextFrame
        tf.WordWrap = -1
        tf.AutoSize = 0
        tf.MarginLeft = tf.MarginRight = 0
        tf.MarginTop = tf.MarginBottom = 0
        if valign is not None:
            tf.VerticalAnchor = valign
        tr = tf.TextRange
        tr.Text = "\r".join(text) if isinstance(text, (list, tuple)) else text
        tr.Font.Name = font; tr.Font.Size = size; tr.Font.Bold = -1 if bold else 0; tr.Font.Italic = -1 if italic else 0
        tr.Font.Color.RGB = rgb(colour)
        tr.ParagraphFormat.Alignment = align
        tr.ParagraphFormat.SpaceAfter = space_after
        if bullets:
            tr.ParagraphFormat.Bullet.Visible = -1
            tr.ParagraphFormat.Bullet.Character = 8226
            tr.IndentLevel = 1
            shp.TextFrame.Ruler.Levels(1).FirstMargin = 0
            shp.TextFrame.Ruler.Levels(1).LeftMargin = 14
        return shp

    def rich(self, s, x, y, w, h, runs, size=14, colour=INK, align=1):
        """runs: list of paragraphs; each paragraph is a list of (text, bold, colour|None)."""
        shp = self.text(s, x, y, w, h, "\r".join("".join(t for t, *_ in p) for p in runs), size, colour=colour, align=align)
        tr = shp.TextFrame.TextRange
        for i, para in enumerate(runs, start=1):
            start = 1
            prange = tr.Paragraphs(i)
            for t, bold, col in para:
                if t:
                    r = prange.Characters(start, len(t))
                    r.Font.Bold = -1 if bold else 0
                    if col:
                        r.Font.Color.RGB = rgb(col)
                start += len(t)
        return shp

    def box(self, s, x, y, w, h, fill=MIST, line=None, rounded=True, radius=0.08):
        shp = s.Shapes.AddShape(5 if rounded else 1, x, y, w, h)
        if rounded:
            shp.Adjustments.SetItem(1, radius)
        shp.Fill.ForeColor.RGB = rgb(fill)
        if line:
            shp.Line.ForeColor.RGB = rgb(line); shp.Line.Weight = 1
        else:
            shp.Line.Visible = 0
        shp.Shadow.Visible = 0
        shp.TextFrame.TextRange.Text = ""
        return shp

    def dot(self, s, x, y, d, fill=TEAL, label="", size=14, colour=WHITE):
        shp = s.Shapes.AddShape(9, x, y, d, d)
        shp.Fill.ForeColor.RGB = rgb(fill); shp.Line.Visible = 0; shp.Shadow.Visible = 0
        tf = shp.TextFrame; tf.MarginLeft = tf.MarginRight = tf.MarginTop = tf.MarginBottom = 0
        tr = tf.TextRange; tr.Text = label; tr.Font.Name = "Calibri"; tr.Font.Size = size; tr.Font.Bold = -1
        tr.Font.Color.RGB = rgb(colour); tr.ParagraphFormat.Alignment = 2
        tf.VerticalAnchor = 3
        return shp

    def arrow(self, s, x1, y1, x2, y2, colour=LINE):
        ln = s.Shapes.AddLine(x1, y1, x2, y2)
        ln.Line.ForeColor.RGB = rgb(colour); ln.Line.Weight = 2; ln.Line.EndArrowheadStyle = 2
        return ln

    def title(self, s, text, sub=None, dark=False):
        self.text(s, M, 34, W - 2 * M, 50, text, 32, colour=(WHITE if dark else INK), font="Cambria")
        if sub:
            self.text(s, M, 86, W - 2 * M, 24, sub, 15, colour=("CBD5E1" if dark else SLATE))

    def table(self, s, rows, x, y, w, col_widths, row_h=24, size=12, header=True, first_col_bold=True):
        nr, nc = len(rows), len(rows[0])
        shp = s.Shapes.AddTable(nr, nc, x, y, w, row_h * nr)
        t = shp.Table
        for c, cw in enumerate(col_widths, start=1):
            t.Columns(c).Width = cw
        for r in range(1, nr + 1):
            t.Rows(r).Height = row_h
            for c in range(1, nc + 1):
                cell = t.Cell(r, c)
                is_head = header and r == 1
                cell.Shape.Fill.ForeColor.RGB = rgb(INK if is_head else (MIST if r % 2 == 0 else WHITE))
                tf = cell.Shape.TextFrame
                tf.MarginLeft = tf.MarginRight = 6; tf.MarginTop = tf.MarginBottom = 3
                tr = tf.TextRange
                tr.Text = str(rows[r - 1][c - 1])
                tr.Font.Name = "Calibri"; tr.Font.Size = size
                tr.Font.Bold = -1 if (is_head or (first_col_bold and c == 1)) else 0
                tr.Font.Color.RGB = rgb(WHITE if is_head else INK)
                for side in (1, 2, 3, 4):
                    b = cell.Borders(side); b.ForeColor.RGB = rgb(LINE); b.Weight = 0.75
        return shp

    # -- output ---------------------------------------------------------------
    def save(self, pptx_path, prefix):
        pptx_path = pathlib.Path(pptx_path)
        RENDERS.mkdir(exist_ok=True)
        self.pres.SaveAs(str(pptx_path), 24)
        pdf = RENDERS / (pptx_path.stem + ".pdf")
        self.pres.SaveAs(str(pdf), 32)
        pngs = []
        for i in range(1, self.pres.Slides.Count + 1):
            p = RENDERS / f"{prefix}-{i:02d}.png"
            self.pres.Slides(i).Export(str(p), "PNG", 1600, 900)
            pngs.append(p)
        self.pres.Close()
        self.app.Quit()
        from common import record_render
        record_render(prefix, pptx_path, pngs)
        return pdf, pngs
