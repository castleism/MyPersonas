from pathlib import Path

from reportlab.lib.colors import Color, HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


OUTPUT = Path(__file__).with_name("AKIKO-ONE-LINE-BREWING-LOG.pdf")

PAGE_W, PAGE_H = letter

INK = HexColor("#20372F")
FOREST = HexColor("#29483D")
CELADON = HexColor("#B9C9B9")
PALE = HexColor("#EDF1EA")
PAPER = HexColor("#F8F5ED")
CEDAR = HexColor("#9C694B")
CINNABAR = HexColor("#B84F3F")
MUTED = HexColor("#5F6B65")
FIELD_FILL = HexColor("#FFFEFA")
HAIRLINE = HexColor("#9EAEA4")


def draw_text_field(
    pdf: canvas.Canvas,
    *,
    label: str,
    name: str,
    x: float,
    y: float,
    width: float,
    height: float = 30,
    multiline: bool = False,
    max_len: int = 240,
    font_size: int = 10,
    tooltip: str | None = None,
) -> None:
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 8.5)
    pdf.drawString(x, y + height + 6, label.upper())
    # PDF text-field flag bit 13 (4096) enables multiline input.
    flags = 4096 if multiline else 0
    pdf.acroForm.textfield(
        name=name,
        tooltip=tooltip or label,
        x=x,
        y=y,
        width=width,
        height=height,
        borderStyle="solid",
        borderWidth=0.8,
        borderColor=HAIRLINE,
        fillColor=FIELD_FILL,
        textColor=INK,
        fontName="Helvetica",
        fontSize=font_size,
        fieldFlags=flags,
        maxlen=max_len,
        forceBorder=True,
    )


def section_label(pdf: canvas.Canvas, number: str, title: str, y: float) -> None:
    pdf.setFillColor(CINNABAR)
    pdf.circle(57, y + 2, 9, stroke=0, fill=1)
    pdf.setFillColor(white)
    pdf.setFont("Helvetica-Bold", 8.5)
    pdf.drawCentredString(57, y - 1, number)
    pdf.setFillColor(FOREST)
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(73, y - 2, title)


def build() -> None:
    pdf = canvas.Canvas(str(OUTPUT), pagesize=letter, pageCompression=1)
    pdf.setTitle("The One-Line Brewing Log")
    pdf.setAuthor("Being Tea Co. - Akiko, fictional AI-generated editorial host")
    pdf.setSubject("A reusable fillable and printable tea brewing comparison log")
    pdf.setCreator("Being Tea Co. owner-review package")

    pdf.setFillColor(PAPER)
    pdf.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)

    # Header
    pdf.setFillColor(FOREST)
    pdf.rect(0, 678, PAGE_W, 114, stroke=0, fill=1)
    pdf.setFillColor(CELADON)
    pdf.setFont("Helvetica-Bold", 8.5)
    pdf.drawString(48, 760, "BEING TEA CO.  |  OWNER-REVIEW DRAFT")
    pdf.setFillColor(white)
    pdf.setFont("Times-Bold", 26)
    pdf.drawString(48, 724, "The One-Line Brewing Log")
    pdf.setFillColor(PALE)
    pdf.setFont("Helvetica", 10.5)
    pdf.drawString(48, 700, "Make better tea. Notice more. Change one thing.")
    pdf.setStrokeColor(CINNABAR)
    pdf.setLineWidth(4)
    pdf.line(48, 686, 142, 686)

    # Method strip
    pdf.setFillColor(PALE)
    pdf.roundRect(48, 630, 516, 34, 7, stroke=0, fill=1)
    pdf.setFillColor(FOREST)
    pdf.setFont("Helvetica-Bold", 9.5)
    pdf.drawString(62, 644, "METHOD")
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 9.5)
    pdf.drawString(116, 644, "Keep every variable steady except the one you are testing.")

    # Section 1
    section_label(pdf, "1", "Set the cup", 605)
    draw_text_field(pdf, label="Date", name="date", x=48, y=548, width=140)
    draw_text_field(
        pdf,
        label="Tea / product",
        name="tea_product",
        x=204,
        y=548,
        width=360,
        max_len=120,
        tooltip="Tea or product name",
    )
    draw_text_field(
        pdf,
        label="Amount",
        name="amount",
        x=48,
        y=493,
        width=110,
        max_len=40,
        tooltip="Leaf or product amount, including unit",
    )
    draw_text_field(
        pdf,
        label="Water",
        name="water",
        x=174,
        y=493,
        width=185,
        max_len=80,
        tooltip="Water amount and type, if useful",
    )
    draw_text_field(
        pdf,
        label="Temperature",
        name="temperature",
        x=375,
        y=493,
        width=90,
        max_len=30,
        tooltip="Water temperature, including unit",
    )
    draw_text_field(
        pdf,
        label="Time",
        name="time",
        x=481,
        y=493,
        width=83,
        max_len=30,
        tooltip="Steep time",
    )
    draw_text_field(
        pdf,
        label="Vessel",
        name="vessel",
        x=48,
        y=438,
        width=516,
        max_len=120,
        tooltip="Brewing vessel or cup",
    )

    # Section 2
    section_label(pdf, "2", "Write one honest observation", 405)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica-Oblique", 8.5)
    pdf.drawRightString(564, 402, "A sentence is enough; no score required.")
    draw_text_field(
        pdf,
        label="One thing I noticed",
        name="observation",
        x=48,
        y=316,
        width=516,
        height=58,
        multiline=True,
        max_len=500,
        font_size=10.5,
        tooltip="One sensory or practical observation from this cup",
    )

    # Section 3
    section_label(pdf, "3", "Choose the next comparison", 283)
    draw_text_field(
        pdf,
        label="One variable to change next",
        name="next_variable",
        x=48,
        y=229,
        width=516,
        height=32,
        max_len=180,
        tooltip="Change only one variable on the next brew",
    )
    draw_text_field(
        pdf,
        label="Optional source / package note",
        name="source_package_note",
        x=48,
        y=157,
        width=516,
        height=42,
        multiline=True,
        max_len=300,
        font_size=9.5,
        tooltip="Optional source, package, batch, cultivar, or other reference note",
    )

    # Footer
    pdf.setStrokeColor(CEDAR)
    pdf.setLineWidth(1.2)
    pdf.line(48, 126, 564, 126)
    pdf.setFillColor(FOREST)
    pdf.setFont("Times-BoldItalic", 10.5)
    pdf.drawString(48, 104, "Tea is not the point. The attention is.")
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 7.8)
    pdf.drawString(
        48,
        81,
        "Akiko is Being Tea Co.'s fictional, AI-generated editorial host. The human owner directs and approves the work;",
    )
    pdf.drawString(
        48,
        69,
        "research, drafting, and visuals may be AI-assisted. This educational record is not medical advice.",
    )
    pdf.setFillColor(HAIRLINE)
    pdf.setFont("Helvetica", 7)
    pdf.drawString(48, 40, "Version: 2026-08-09  |  Local owner-review draft  |  Not yet published")
    pdf.drawRightString(564, 40, "being tea co.")

    pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    build()
