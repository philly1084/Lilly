from io import BytesIO

from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

SOURCE = 'tmp/pdfs/lease-source.pdf'
OUTPUT = 'output/pdf/form-p-standard-form-lease-signed-philip-asplin.pdf'
SIGNATURE_FONT = r'C:\Windows\Fonts\segoesc.ttf'

reader = PdfReader(SOURCE)
writer = PdfWriter()

for page_number, page in enumerate(reader.pages):
    if page_number == 13:  # F9, the lease signature page
        overlay_buffer = BytesIO()
        overlay = canvas.Canvas(overlay_buffer, pagesize=(612, 792))
        pdfmetrics.registerFont(TTFont('SegoeScript', SIGNATURE_FONT))
        overlay.setFillColorRGB(0.05, 0.12, 0.35)
        overlay.setFont('SegoeScript', 24)
        # First tenant row, within the existing signature rule.
        overlay.drawString(375, 281, 'Philip Asplin')
        overlay.save()
        overlay_buffer.seek(0)
        page.merge_page(PdfReader(overlay_buffer).pages[0])
    writer.add_page(page)

with open(OUTPUT, 'wb') as file_handle:
    writer.write(file_handle)
