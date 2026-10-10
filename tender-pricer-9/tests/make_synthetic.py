"""Build a small fake tender with a completely different layout than Oberglatt:
NPK position numbers, no bold titles, quantity LEFT of the unit, other units,
other column positions, two sections with their own page counters."""
import pymupdf

SECTIONS = {
    "Anlage 1 Büro": [
        ("111.101", "Zuluftventil Metall", ["Fabrikat z.B. Halton", "Typ z.B. ULA", "Grösse Ø 160 mm"], 12, "St."),
        ("111.102", "Brandschutzklappe EI90-S mit Antrieb", ["Grösse B x H 400 x 200 mm"], 3, "St."),
        ("111.103", "Thermische Aussendämmung 30/5", ["Mineralwolle mit Alu-Folie"], 85, "m2"),
    ],
    "Anlage 2 Werkstatt": [
        ("112.101", "Variabler Volumenstromregler rund", ["Typ z.B. TVR", "Grösse Ø 200 mm"], 7, "St."),
        ("112.102", "Rohrschalldämpfer", ["Ø 250 mm, Länge 1000 mm"], 4, "St."),
        ("112.103", "Einregulierung und Inbetriebsetzen der Anlage", ["inkl. Messprotokoll"], 1, "psch"),
    ],
}


def make(path):
    doc = pymupdf.open()
    cover = doc.new_page()
    cover.insert_text((60, 100), "Ausschreibung Lüftung Musterhaus", fontsize=16)
    cover.insert_text((60, 140), "Allgemeine Bedingungen: Die Preise verstehen sich netto.", fontsize=10)
    for sec, items in SECTIONS.items():
        per_page = 2
        pages = [items[i:i + per_page] for i in range(0, len(items), per_page)]
        for k, chunk in enumerate(pages, 1):
            p = doc.new_page()
            p.insert_text((40, 30), "Musterhaus Basel", fontsize=9)
            p.insert_text((220, 30), sec, fontsize=9)
            p.insert_text((480, 30), f"Page {k} / {len(pages)}", fontsize=9)
            p.insert_text((40, 55), "Pos.   Beschreibung", fontsize=8)
            p.insert_text((420, 55), "Menge  Einheit   EP   Total", fontsize=8)
            y = 90
            for pos, title, lines, qty, unit in chunk:
                p.insert_text((40, y), pos, fontsize=9.5)
                p.insert_text((110, y), title, fontsize=9.5)
                y += 13
                for l in lines:
                    p.insert_text((110, y), l, fontsize=9.5); y += 13
                p.insert_text((440, y - 13), str(qty), fontsize=9.5)
                p.insert_text((480, y - 13), unit, fontsize=9.5)
                y += 20
            p.insert_text((40, 815), "Musterhaus Basel  Leistungsverzeichnis", fontsize=7)
    doc.save(path)


if __name__ == "__main__":
    make("synthetic_tender.pdf")
