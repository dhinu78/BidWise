"""Small synthetic HEATING and SANITARY tenders + matching sample catalogues.

Layout differs from the ventilation tender on purpose (NPK numbers, no bold titles,
quantity left of the unit, 'Page k / n' counters), so the tests exercise the
layout learner, the 3-trade vocabulary, the translation and the catalogue matcher together."""
from pathlib import Path
import pandas as pd
import pymupdf

HEATING = {
    "cover": ["Ausschreibung BKP 242/243 Heizungsanlagen", "Neubau Schulhaus Muster", "Allgemeine Bedingungen ..."],
    "sections": {
        "242 Wärmeerzeugung": [
            ("242.101", "Wärmepumpe Luft/Wasser", ["Heizleistung 45 kW", "Fabrikat z.B. Hoval", "Typ z.B. Belaria"], 1, "St."),
            ("242.102", "Pufferspeicher 1000 Liter", ["Stahl, isoliert"], 1, "St."),
            ("242.103", "Umwälzpumpe Heizgruppe", ["Hocheffizienz, DN 32", "Fabrikat z.B. Grundfos"], 2, "St."),
        ],
        "243 Wärmeverteilung": [
            ("243.101", "Plattenheizkörper Typ 22", ["Grösse 600 x 1000 mm"], 12, "St."),
            ("243.102", "Thermostatventil gerade", ["DN 15"], 12, "St."),
            ("243.103", "Stahlrohr geschweisst", ["DN 25"], 120, "m"),
            ("243.104", "Rohrisolation 30 mm", ["Mineralwolle mit Alu-Mantel"], 120, "m"),
            ("243.105", "Druckprobe und Spülung", ["inkl. Protokoll"], 1, "psch"),
        ],
    },
}
HEATING_CATALOG = [
    ("H-HP-45", "Heat generation", "Heat pump", "Air-to-water heat pump 45 kW", "pc", 52000, "HEAT_PUMP", "supplier_package"),
    ("H-HP-60", "Heat generation", "Heat pump", "Air-to-water heat pump 60 kW", "pc", 64000, "HEAT_PUMP", "supplier_package"),
    ("H-TANK-1000", "Storage", "Buffer tank", "Buffer tank 1000 l insulated", "pc", 3400, "TANK", "catalog"),
    ("H-PUMP-32", "Pumps", "Circulation pump", "High-efficiency circulation pump DN32", "pc", 980, "PUMP", "catalog"),
    ("H-RAD-22-600-1000", "Heat emitters", "Radiator", "Panel radiator type 22 600x1000 mm", "pc", 310, "RADIATOR", "catalog"),
    ("H-TRV-15", "Heat emitters", "Radiator valve", "Thermostatic radiator valve DN15", "pc", 45, "RADIATOR_VALVE", "catalog"),
    ("H-PIPE-ST-25", "Pipework", "Steel pipe", "Steel pipe welded DN25", "m", 21, "PIPE_STEEL", "catalog"),
    ("H-PIPE-ST-32", "Pipework", "Steel pipe", "Steel pipe welded DN32", "m", 26, "PIPE_STEEL", "catalog"),
    ("H-INS-30", "Insulation", "Pipe insulation", "Pipe insulation mineral wool 30 mm", "m", 18, "PIPE_INSULATION", "catalog"),
]

SANITARY = {
    "cover": ["Ausschreibung BKP 251/254 Sanitäranlagen", "Neubau Schulhaus Muster", "Allgemeine Bedingungen ..."],
    "sections": {
        "251 Sanitärapparate": [
            ("251.101", "Wand-WC Keramik", ["weiss, spülrandlos"], 8, "St."),
            ("251.102", "Unterputzspülkasten", ["mit Betätigungsplatte"], 8, "St."),
            ("251.103", "Waschtisch Keramik", ["Grösse 60 x 45 cm"], 10, "St."),
            ("251.104", "Einhebelmischer Waschtisch", ["verchromt"], 10, "St."),
        ],
        "254 Sanitärleitungen": [
            ("254.101", "Abwasserleitung PE", ["d 110"], 45, "m"),
            ("254.102", "Kaltwasserleitung Inox", ["28 x 1.2 mm"], 60, "m"),
            ("254.103", "Brandschutzmanschette", ["d 110"], 6, "St."),
            ("254.104", "Wassererwärmer 500 Liter", ["Fabrikat z.B. Domotec"], 1, "St."),
        ],
    },
}
SANITARY_CATALOG = [
    ("S-WC-01", "Sanitary fixtures", "WC", "Wall-hung WC ceramic rimless", "pc", 420, "WC", "catalog"),
    ("S-CIS-01", "Sanitary fixtures", "Cistern", "Concealed cistern with flush plate", "pc", 380, "SANITARY_FIXTURE", "catalog"),
    ("S-WB-60", "Sanitary fixtures", "Washbasin", "Washbasin ceramic 600x450 mm", "pc", 290, "WASHBASIN", "catalog"),
    ("S-TAP-01", "Tapware", "Mixer tap", "Single-lever basin mixer tap chrome", "pc", 210, "TAP", "catalog"),
    ("S-PE-110", "Pipework", "Drainage pipe", "PE drainage pipe d110", "m", 38, "PIPE_DRAIN", "catalog"),
    ("S-PE-125", "Pipework", "Drainage pipe", "PE drainage pipe d125", "m", 44, "PIPE_DRAIN", "catalog"),
    ("S-INOX-28", "Pipework", "Supply pipe", "Stainless steel press pipe drinking water 28 x 1.2 mm", "m", 34, "PIPE_SUPPLY", "catalog"),
    ("S-FC-110", "Fire protection", "Fire collar", "Fire collar for plastic pipe d110", "pc", 95, "FIRE_SEAL", "catalog"),
    ("S-WH-500", "Water heating", "Water heater", "Water heater 500 l", "pc", 4200, "WATER_HEATER", "supplier_package"),
]
CAT_COLS = ["product_id", "category", "subcategory", "description", "unit", "list_price_chf",
            "install_code", "source_type"]


def make_pdf(path, spec):
    doc = pymupdf.open()
    cover = doc.new_page()
    for k, line in enumerate(spec["cover"]):
        cover.insert_text((60, 100 + 30 * k), line, fontsize=14 if k == 0 else 10)
    for sec, items in spec["sections"].items():
        pages = [items[i:i + 3] for i in range(0, len(items), 3)]
        for k, chunk in enumerate(pages, 1):
            p = doc.new_page()
            p.insert_text((40, 30), "Schulhaus Muster", fontsize=9)
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
            p.insert_text((40, 815), "Schulhaus Muster  Leistungsverzeichnis", fontsize=7)
    doc.save(path)


def make(tmp: Path, which: str) -> tuple[Path, Path]:
    spec, cat = (HEATING, HEATING_CATALOG) if which == "heating" else (SANITARY, SANITARY_CATALOG)
    pdf, csv = tmp / f"{which}.pdf", tmp / f"{which}_catalog.csv"
    make_pdf(pdf, spec)
    pd.DataFrame(cat, columns=CAT_COLS).to_csv(csv, index=False)
    return pdf, csv
