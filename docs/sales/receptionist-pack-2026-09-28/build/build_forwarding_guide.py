"""Call forwarding guide (.docx): built from call-forwarding-guide.md so the two never drift apart."""
import markdown

from common import *

SOURCE = PACK / "call-forwarding-guide.md"

if __name__ == "__main__":
    md = SOURCE.read_bytes().decode("utf-8")
    body = markdown.markdown(md, extensions=["tables", "sane_lists"])
    pdf, pages = build_docx(html_doc(body), PACK / "call-forwarding-guide.docx",
                            "M&U Ventures · Call forwarding guide · your number never changes or ports",
                            f"Built from call-forwarding-guide.md · {AS_OF}")
    print(pdf, pages, len(rasterise(pdf, "call-forwarding-guide")))
