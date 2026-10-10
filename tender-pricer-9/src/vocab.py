"""Domain vocabulary for Swiss building services tenders (German LV):

    ventilation  BKP 244 / 245  Lüftung, Klima
    heating      BKP 242 / 243  Wärmeerzeugung, Wärmeverteilung (Heizung)
    sanitary     BKP 25x        Sanitäranlagen (Apparate, Leitungen, Dämmungen)

How classification works (normalize.classify):
  1. rules of the tender's trade, top to bottom   -> first rule whose keywords match wins
  2. rules shared by all trades (controls, supports, services ...)
  3. rules of the other trades (combined tenders, odd wording)
Keywords: all strings in one tuple must appear (AND); any tuple may match (OR).
Put specific words (Brandschutzklappe, Thermostatventil) before generic ones (Klappe, Ventil).

Extend this file when a tender uses words we have not seen. Install codes are HINTS:
the authoritative code comes from the matched catalogue product (catalog.csv install_code).
"""
from __future__ import annotations
import re
from collections import namedtuple

V, H, S = "ventilation", "heating", "sanitary"
ALL = (V, H, S)

UNIT_MAP = {
    "stk": "pc", "st": "pc", "stück": "pc", "pce": "pc", "pc": "pc", "pcs": "pc", "pièce": "pc", "pz": "pc",
    "paar": "pc", "garnitur": "pc",
    "m": "m", "lfm": "m", "m1": "m", "ml": "m", "lm": "m",
    "m2": "m2", "m²": "m2",
    "m3": "m3", "m³": "m3",
    "psch": "LS", "pauschal": "LS", "ls": "LS", "gl": "LS", "global": "LS", "fft": "LS",
    "h": "h", "std": "h", "std.": "h",
    "kg": "kg", "t": "kg",
    "l": "l", "lt": "l", "liter": "l",
    "anlage": "system", "anl": "system", "satz": "system",
}

TAKEOFF_KEYWORDS = ["Bauteilliste", "Materialliste", "Stückliste", "Materialauszug Liste", "Auflistung der Kanäle"]

# ---------------------------------------------------------------- trade detection
TRADE_BKP = [(re.compile(r"\bBKP\s*24[45]\b|\b24[45]\.\d"), V),
             (re.compile(r"\bBKP\s*24[23]\b|\b24[23]\.\d"), H),
             (re.compile(r"\bBKP\s*25\d\b|\b25\d\.\d"), S)]
TRADE_WORDS = {
    V: ["lüftung", "lufttechnisch", "luftmenge", "zuluft", "abluft", "kanal", "volumenstromregler", "klima"],
    H: ["heizung", "wärmeerzeugung", "wärmeverteilung", "heizkörper", "vorlauf", "rücklauf", "wärmepumpe",
        "fussbodenheizung", "heizkessel"],
    S: ["sanitär", "sanitar", "trinkwasser", "abwasser", "waschtisch", "klosett", "wc", "armatur",
        "spülkasten", "fallleitung", "kaltwasser", "warmwasser"],
}

# ---------------------------------------------------------------- categories
CATEGORIES = {
    V: ["Air terminal", "Fire protection", "Damper", "Silencer", "Flow controller", "Ductwork",
        "Insulation", "Equipment", "Controls", "Support", "Service", "Other"],
    H: ["Heat generation", "Storage", "Heat distribution", "Pumps", "Valves", "Pipework", "Heat emitters",
        "Flue system", "Insulation", "Controls", "Support", "Fire protection", "Service", "Other"],
    S: ["Sanitary fixtures", "Tapware", "Accessories", "Drainage", "Water supply", "Water heating",
        "Water treatment", "Pumps", "Pipework", "Fire fighting", "Fire protection", "Insulation",
        "Support", "Service", "Other"],
}
# names a catalogue might use for the same category (lower case)
CATEGORY_ALIASES = {
    "Air terminal": ["air terminals", "terminal", "diffuser", "grilles", "luftdurchlass"],
    "Flow controller": ["flow controllers", "vav", "volume flow controller"],
    "Ductwork": ["duct", "ducts", "ductwork", "kanäle"],
    "Pipework": ["pipe", "pipes", "piping", "pipework", "leitungen", "rohrleitungen", "pipes and fittings"],
    "Valves": ["valve", "fittings", "armaturen", "valves and fittings"],
    "Heat generation": ["heat generator", "heat source", "boiler", "heat pumps", "wärmeerzeugung"],
    "Heat emitters": ["radiators", "heating surfaces", "emitter", "wärmeabgabe"],
    "Heat distribution": ["distribution", "manifolds", "wärmeverteilung"],
    "Sanitary fixtures": ["fixtures", "sanitary appliances", "sanitary ware", "apparate"],
    "Tapware": ["taps", "mixers", "faucets", "sanitary fittings"],
    "Drainage": ["drains", "waste water", "entwässerung"],
    "Water heating": ["water heater", "hot water", "dhw"],
    "Equipment": ["equipment", "units", "apparate", "plant"],
    "Insulation": ["insulation", "dämmung", "isolation", "lagging"],
    "Controls": ["controls", "control", "msr", "instrumentation"],
    "Support": ["supports", "fixings", "mounting", "befestigung"],
    "Fire protection": ["fire", "fire safety", "brandschutz"],
    "Pumps": ["pump", "pumps"],
    "Storage": ["tanks", "storage", "vessels", "speicher"],
}

# ---------------------------------------------------------------- rules
Rule = namedtuple("Rule", "trades category subcategory english install_code keywords")

_VENT = [
    # specific items whose names contain generic words like "Kanal" or "Schalldämpfer"
    ("Equipment", "AHU section", "Air-handling unit section", "AHU_LARGE",
     [("schalldämpferteil",), ("leerteil",), ("tropfenabscheider",), ("geräteanschluss",),
      ("filterteil",), ("ventilatorteil",), ("wärmetauscherteil",), ("kühlerteil",), ("erhitzerteil",)]),
    ("Controls", "Field device", "Control field device", "CONTROL_POINT",
     [("thermometer",), ("rauchmelder",), ("potentialverbindung",), ("potentialausgleich",)]),
    ("Service", "Testing", "Testing and calculations", "UNKNOWN",
     [("dichtheitsprüfung",), ("berechnung",), ("prüfprotokoll",)]),
    ("Service", "Transport", "Shipping and handling", "UNKNOWN",
     [("versandkosten",), ("fracht",), ("transport",)]),
    ("Equipment", "Kitchen hood", "Kitchen exhaust hood", "UNKNOWN",
     [("evs-w",), ("dunstabzug",), ("küchenhaube",), ("abzugshaube",)]),
    ("Air terminal", "Kitchen ceiling element", "Ventilated ceiling element", "DIFFUSER",
     [("kassette",), ("dqa ",), ("frontplatte",), ("lochblechverkleidung",)]),
    ("Air terminal", "Transfer unit", "Transfer air unit", "DIFFUSER",
     [("überströmer",), ("überström",)]),
    ("Air terminal", "Diffuser", "Air diffuser", "DIFFUSER",
     [("wirbelstrahl",), ("düsenrohr",), ("drallauslass",), ("deckenauslass",), ("quellauslass",)]),
    ("Service", "Labour", "Installation labour", "UNKNOWN",
     [(" montage ",)]),
    ("Fire protection", "Fire damper", "Fire damper", "FIRE_DAMPER",
     [("brandschutzklappe",), ("brandschutzklappen",), ("bsk ",)]),
    ("Fire protection", "Inspection cover", "Inspection cover for fire insulation", "FIRE_ACCESS",
     [("revisionsdeckel",), ("revisisondeckel",), ("revisionsöffnung", "brand")]),
    ("Fire protection", "Fire seal", "Fire penetration sealing", "FIRE_SEAL",
     [("durchdringung",), ("durchführung", "ei"), ("abschottung",), ("verbundprofil", "ei30")]),
    ("Flow controller", "VAV", "Variable volume flow controller", "VAV_CONTROLLER",
     [("volumenstromregler", "variab"), ("vvs",), ("tvr",), ("tvj",), ("vav",)]),
    ("Flow controller", "CAV", "Constant volume flow controller", "CAV_CONTROLLER",
     [("volumenstromregler", "konstant"), ("vfc",), ("cav",), ("konstantvolumen",)]),
    ("Flow controller", "VAV", "Volume flow controller", "VAV_CONTROLLER",
     [("volumenstromregler",)]),
    ("Silencer", "Silencer", "Silencer", "SILENCER",
     [("schalldämpfer",), ("kulisse",)]),
    ("Damper", "Manual damper", "Manual balancing damper", "DAMPER",
     [("drosselklappe",), ("regulierklappe",), ("irisblende",)]),
    ("Damper", "Shut-off damper", "Shut-off damper", "DAMPER",
     [("jalousieklappe",), ("absperrklappe",), ("luftklappe",), ("rückschlagklappe",)]),
    ("Air terminal", "Supply valve", "Supply air valve", "DIFFUSER",
     [("zuluft", "ventil"), ("zuluftventil",)]),
    ("Air terminal", "Exhaust valve", "Exhaust air valve", "DIFFUSER",
     [("abluft", "ventil"), ("abluftventil",)]),
    ("Air terminal", "Grille", "Air grille", "DIFFUSER",
     [("gitter",), ("drallauslass",), ("luftauslass",), ("schlitzauslass",), ("weitwurfdüse",), ("tellerventil",)]),
    ("Air terminal", "Weather louvre", "Weather hood / louvre", "UNKNOWN",
     [("regenhut",), ("lamellenhut",), ("wetterschutz",), ("dachhaube",)]),
    ("Insulation", "Fire insulation", "Fire protection insulation", "UNKNOWN",
     [("brandschutzdämmung",), ("brandschutzverkleidung",), ("dämmung", "ei30"), ("dämmung", "ei 30"),
      ("dämmung", "ei60"), ("dämmung", "ei 60"), ("dämmung", "ei90"), ("dämmung", "ei 90")]),
    ("Insulation", "Insulation", "Duct insulation", "INSULATION",
     [("dämmung",), ("isolation",), ("ummantelung",)]),
    ("Equipment", "Air-handling unit", "Air-handling unit", "AHU_LARGE",
     [("zuluftgerät",), ("abluftgerät",), ("lüftungsgerät",), ("monoblock",), ("kompaktgerät",),
      ("fortluft", "-"), ("filterteil",), ("ventilatorteil",), ("wrg",), ("wärmetauscher",),
      ("luftkühler",), ("lufterhitzer",), ("mischteil",), ("kammer",)]),
    ("Equipment", "Fan", "Fan unit", "FAN",
     [("ventilator",), ("dachlüfter",), ("rohrventilator",)]),
]

_VENT_TAIL = [   # generic ventilation words, after the shared rules
    ("Ductwork", "Bend", "Duct bend", "DUCT_FITTING",
     [("bogen",), ("winkel",)]),
    ("Ductwork", "Fitting", "Duct fitting", "DUCT_FITTING",
     [("formstück",), ("übergang",), ("abzweig",), ("t-stück",), ("reduktion",), ("manschette",),
      ("endkappe",), ("deckel",), ("stutzen",), ("anschlusskasten",)]),
    ("Ductwork", "Duct", "Duct", "DUCT",
     [("kanal",), ("rohr",), ("spiro",), ("luftleitung",), ("flexrohr",), ("schlauch",)]),
]

_HEAT = [
    # heat generation
    ("Heat generation", "Heat pump", "Heat pump", "HEAT_PUMP",
     [("wärmepumpe",)]),
    ("Heat generation", "Boiler", "Boiler", "BOILER",
     [("heizkessel",), ("gaskessel",), ("ölkessel",), ("pelletkessel",), ("brennwertkessel",), ("holzkessel",),
      ("kessel",), ("wärmeerzeuger",)]),
    ("Heat generation", "District heating substation", "District heating substation", "SUBSTATION",
     [("fernwärme",), ("übergabestation",), ("hausstation",)]),
    ("Heat generation", "Heat exchanger", "Heat exchanger", "HEAT_EXCHANGER",
     [("plattenwärmetauscher",), ("wärmetauscher",), ("wärmeübertrager",), ("plattentauscher",)]),
    ("Heat generation", "Solar collector", "Solar thermal collector", "SOLAR_COLLECTOR",
     [("sonnenkollektor",), ("solarkollektor",), ("kollektorfeld",)]),
    ("Heat generation", "Geothermal probe", "Geothermal probe", "GEO_PROBE",
     [("erdwärmesonde",), ("erdsonde",)]),
    # storage and pressure
    ("Storage", "Buffer tank", "Buffer tank", "TANK",
     [("pufferspeicher",), ("speicher",)]),
    ("Storage", "Expansion vessel", "Expansion vessel", "EXPANSION_VESSEL",
     [("expansionsgefäss",), ("ausdehnungsgefäss",), ("membranausdehnung",), ("druckhaltung",),
      ("expansionsanlage",)]),
    ("Flue system", "Flue", "Flue gas system", "FLUE",
     [("abgasleitung",), ("abgassystem",), ("abgas",), ("kamin",), ("rauchrohr",)]),
    # distribution
    ("Heat distribution", "Heat meter", "Heat meter", "HEAT_METER",
     [("wärmezähler",), ("energiezähler",), ("kältezähler",)]),
    ("Pumps", "Circulation pump", "Circulation pump", "PUMP",
     [("umwälzpumpe",), ("heizungspumpe",), ("pumpe",)]),
    ("Heat distribution", "Manifold", "Heating manifold", "MANIFOLD",
     [("heizkreisverteiler",), ("verteiler",), ("sammler",), ("heizgruppe",), ("verteilbalken",)]),
    # emitters (before valves: "Heizkörperventil")
    ("Heat emitters", "Radiator valve", "Thermostatic radiator valve", "RADIATOR_VALVE",
     [("thermostatventil",), ("heizkörperventil",), ("ventilunterteil",), ("thermostatkopf",),
      ("rücklaufverschraubung",), ("radiatorventil",)]),
    ("Heat emitters", "Radiator", "Radiator", "RADIATOR",
     [("heizkörper",), ("radiator",), ("röhrenradiator",), ("handtuchradiator",)]),
    ("Heat emitters", "Convector", "Convector", "CONVECTOR",
     [("konvektor",), ("unterflurkonvektor",)]),
    ("Heat emitters", "Underfloor heating", "Underfloor heating", "UFH",
     [("fussbodenheizung",), ("bodenheizung",), ("flächenheizung",), ("heizrohr",), ("heizschlange",)]),
    ("Heat emitters", "Radiant ceiling panel", "Radiant ceiling panel", "RADIANT_PANEL",
     [("deckenstrahl",), ("strahlplatte",), ("heizdecke",), ("deckenheizung",)]),
    ("Heat emitters", "Unit heater", "Unit heater", "UNIT_HEATER",
     [("lufterhitzer",), ("heizregister",), ("torluftschleier",)]),
    # valves
    ("Valves", "Mixing valve", "Mixing valve", "VALVE",
     [("mischventil",), ("dreiwegventil",), ("3-weg",), ("mischer",)]),
    ("Valves", "Balancing valve", "Balancing valve", "VALVE",
     [("strangregulier",), ("strangventil",), ("regulierventil",), ("differenzdruckregler",), ("abgleichventil",)]),
    ("Valves", "Safety valve", "Safety valve", "VALVE",
     [("sicherheitsventil",), ("sicherheitsgruppe",)]),
    ("Valves", "Strainer", "Strainer / dirt separator", "VALVE",
     [("schmutzfänger",), ("schlammabscheider",), ("magnetitabscheider",), ("luft- und schlamm",)]),
    ("Valves", "Air vent", "Air vent / drain", "VALVE",
     [("entlüfter",), ("luftabscheider",), ("entleerung",), ("entlüftung",)]),
    ("Water treatment", "Heating water treatment", "Heating water treatment", "WATER_TREATMENT",
     [("füllwasser",), ("wasseraufbereitung",), ("vollentsalzung",), ("enthärtung",)]),
]

_SAN = [
    ("Sanitary fixtures", "Installation frame", "Installation frame", "INSTALL_FRAME",
     [("montageelement",), ("vorwandelement",), ("vorwandinstallation",), ("installationselement",),
      ("duofix",), ("tragelement",), ("sanitärelement",)]),
    ("Water supply", "Distribution manifold", "Water distribution manifold", "MANIFOLD",
     [("verteilbatterie",), ("verteiler",), ("hausanschluss",), ("hauptabsperr",)]),
    ("Tapware", "Shower set", "Shower head / shower set", "TAP",
     [("brause",), ("duschbrause",), ("kopfbrause",)]),
    ("Tapware", "Mixer tap", "Mixer tap", "TAP",
     [("mischbatterie",), ("einhebel",), ("mischer",), ("batterie",), ("selbstschluss",), ("wasserhahn",),
      ("auslaufventil",), ("armatur",)]),
    ("Sanitary fixtures", "Urinal", "Urinal", "URINAL",
     [("urinal",), ("pissoir",)]),
    ("Sanitary fixtures", "Cistern", "Concealed cistern / flush plate", "SANITARY_FIXTURE",
     [("spülkasten",), ("betätigungsplatte",), ("drückerplatte",), ("spülauslösung",)]),
    ("Sanitary fixtures", "WC", "Wall-hung WC", "WC",
     [("wand-wc",), ("klosett",), ("wc-anlage",), ("tiefspül",), (" wc",), ("toilette",)]),
    ("Sanitary fixtures", "Washbasin", "Washbasin", "WASHBASIN",
     [("waschtisch",), ("lavabo",), ("handwaschbecken",), ("waschrinne",), ("waschbecken",)]),
    ("Sanitary fixtures", "Sink", "Sink", "SINK",
     [("spültisch",), ("ausgussbecken",), ("ausguss",), ("spülbecken",), ("putzbecken",)]),
    ("Sanitary fixtures", "Shower", "Shower", "SHOWER",
     [("duschwanne",), ("duschtasse",), ("duschtrennwand",), ("duschabtrennung",), ("dusche",)]),
    ("Sanitary fixtures", "Bathtub", "Bathtub", "BATHTUB",
     [("badewanne",)]),
    ("Sanitary fixtures", "Drinking fountain", "Drinking fountain", "SANITARY_FIXTURE",
     [("trinkbrunnen",)]),
    ("Accessories", "Accessory", "Sanitary accessory", "ACCESSORY",
     [("spiegel",), ("seifenspender",), ("papierhalter",), ("handtuch",), ("haltegriff",), ("stützgriff",),
      ("garderobe",), ("ablage",), ("abfallbehälter",), ("wc-bürste",), ("klappsitz",)]),
    ("Drainage", "Floor drain", "Floor drain / gully", "FLOOR_DRAIN",
     [("bodenablauf",), ("duschrinne",), ("ablaufrinne",), ("bodenrinne",), ("dachwasserablauf",),
      ("dachablauf",), ("notüberlauf",)]),
    ("Drainage", "Separator", "Separator (grease / oil)", "SEPARATOR",
     [("fettabscheider",), ("ölabscheider",), ("benzinabscheider",), ("schlammsammler",), ("stärkeabscheider",)]),
    ("Pumps", "Lifting station", "Sewage lifting station", "LIFTING_STATION",
     [("hebeanlage",), ("abwasserpumpe",), ("tauchpumpe",), ("schmutzwasserpumpe",)]),
    ("Pumps", "Circulation pump", "Circulation pump", "PUMP",
     [("zirkulationspumpe",), ("pumpe",)]),
    ("Water heating", "Water heater", "Water heater", "WATER_HEATER",
     [("wassererwärmer",), ("warmwasserspeicher",), ("boiler",), ("durchlauferhitzer",), ("elektroboiler",),
      ("speicher",)]),
    ("Water treatment", "Softener", "Water softener", "WATER_TREATMENT",
     [("enthärtung",), ("wasserenthärter",), ("dosieranlage",), ("rückspülfilter",), ("feinfilter",), ("filter",)]),
    ("Water supply", "Water meter", "Water meter", "WATER_METER",
     [("wasserzähler",)]),
    ("Water supply", "Pressure reducer", "Pressure reducing valve", "VALVE",
     [("druckreduzier",), ("druckminder",)]),
    ("Water supply", "Backflow preventer", "Backflow preventer", "VALVE",
     [("systemtrenner",), ("rückflussverhinderer",), ("rohrtrenner",)]),
    ("Water supply", "Angle valve", "Angle valve", "VALVE",
     [("eckventil",), ("eckregulier",)]),
    ("Fire fighting", "Fire hose reel", "Fire hose reel", "FIRE_HOSE",
     [("wandhydrant",), ("löschposten",), ("feuerlösch",), ("sprinkler",), ("löschwasser",)]),
    # pipework (before the shared generic "Rohr")
    ("Pipework", "Drainage pipe", "Drainage pipe", "PIPE_DRAIN",
     [("abwasser",), ("schmutzwasser",), ("fallleitung",), ("grundleitung",), ("sammelleitung",),
      ("regenwasser",), ("meteorwasser",), ("entwässerung",), ("lüftungsleitung",), ("gussrohr",)]),
    ("Pipework", "Supply pipe", "Drinking water pipe", "PIPE_SUPPLY",
     [("trinkwasser",), ("kaltwasser",), ("warmwasser",), ("zirkulation",), ("wasserleitung",)]),
]

_SHARED = [
    # pipework (heating + sanitary) by material
    ("Pipework", "Steel pipe", "Steel pipe", "PIPE_STEEL",
     [("stahlrohr",), ("gewinderohr",), ("siederohr",), ("c-stahl",), ("präzisionsstahl",)]),
    ("Pipework", "Stainless steel pipe", "Stainless steel pipe", "PIPE_STAINLESS",
     [("edelstahlrohr",), ("chromstahlrohr",), ("inox",)]),
    ("Pipework", "Copper pipe", "Copper pipe", "PIPE_COPPER",
     [("kupferrohr",), ("kupfer",)]),
    ("Pipework", "Multilayer pipe", "Multilayer composite pipe", "PIPE_PLASTIC",
     [("mehrschicht",), ("verbundrohr",), ("alu-verbund",)]),
    ("Pipework", "Plastic pipe", "Plastic pipe", "PIPE_PLASTIC",
     [("pe-rohr",), ("pp-rohr",), ("pvc-rohr",), ("kunststoffrohr",), ("pe-x",), ("pex",)]),
    ("Pipework", "Press pipe", "Press-fit pipe", "PIPE_PRESS",
     [("pressrohr",), ("pressfitting",), ("presssystem",), ("mapress",)]),
    ("Pipework", "Pipe fitting", "Pipe fitting", "PIPE_FITTING",
     [("rohrbogen",), ("t-stück",), ("reduktion",), ("fitting",), ("muffe",), ("übergangsstück",)]),
    ("Pipework", "Expansion joint", "Expansion joint", "PIPE_FITTING",
     [("kompensator",), ("dehnungsausgleich",)]),
    ("Fire protection", "Fire collar", "Fire collar / pipe penetration seal", "FIRE_SEAL",
     [("brandschutzmanschette",), ("brandschutzband",), ("brandschott",)]),
    ("Valves", "Check valve", "Check valve", "VALVE",
     [("rückschlag",)]),
    ("Valves", "Shut-off valve", "Shut-off valve", "VALVE",
     [("kugelhahn",), ("absperrventil",), ("absperrklappe",), ("schieber",), ("absperrarmatur",),
      ("absperrhahn",), ("ventil",)]),
    ("Insulation", "Pipe insulation", "Pipe insulation", "PIPE_INSULATION",
     [("rohrisolation",), ("rohrdämmung",), ("armaturenisolation",), ("schallschutz",), ("körperschall",)]),
    # controls (catalogue wording: differential pressure transmitter, temperature sensor, actuator ...)
    ("Controls", "Differential pressure transmitter", "Differential pressure transmitter", "CONTROL_POINT",
     [("druckdifferenz",), ("differenzdruck", "fühler"), ("differenzdruck", "transmitter")]),
    ("Controls", "Temperature sensor", "Temperature sensor", "CONTROL_POINT",
     [("temperaturfühler",), ("aussenfühler",), ("tauchfühler",), ("anlegefühler",), ("raumfühler",)]),
    ("Controls", "Volume flow transmitter", "Volume flow transmitter", "CONTROL_POINT",
     [("volumenstrom", "messumformer"), ("volumenstrommessung",)]),
    ("Controls", "Actuator", "Actuator 24V", "CONTROL_POINT",
     [("stellantrieb",), ("drehantrieb",), ("antrieb",), ("stellmotor",)]),
    ("Controls", "Field device", "Control field device", "CONTROL_POINT",
     [("fühler",), ("sensor",), ("messumformer",), ("druckschalter",), ("druckwächter",), ("thermostat",),
      ("manometer",), ("thermometer",), ("regler",), ("wächter",)]),
    ("Support", "Angle set", "Connection-angle set", "SUPPORT_SET",
     [("anschlusswink",), ("befestigungswinkel",)]),
    ("Support", "Support", "Supports and mounting", "SUPPORT_SET",
     [("rohrbefestigung",), ("rohrschelle",), ("befestigung",), ("montagefüss",),
      ("montageschiene",), ("konsole",), ("aufhängung",), ("grundplatte",), ("sockel",), ("fixpunkt",)]),
    ("Insulation", "Insulation", "Insulation", "INSULATION",
     [("dämmung",), ("isolation",), ("ummantelung",)]),
    ("Service", "Pressure test", "Pressure test", "UNKNOWN",
     [("druckprobe",), ("druckprüfung",), ("dichtheitsprüfung",)]),
    ("Service", "Flushing", "Flushing and disinfection", "UNKNOWN",
     [("spülung",), ("spülen",), ("desinfektion",)]),
    ("Service", "Commissioning", "Commissioning and balancing", "COMMISSION_SYSTEM",
     [("einregulierung",), ("inbetriebsetz",), ("inbetriebnahme",), ("hydraulischer abgleich",),
      ("messprotokoll",), ("abnahme",)]),
    ("Service", "Documentation", "Documentation", "DOCUMENT_SYSTEM",
     [("dokumentation",), ("revisionsunterlagen",), ("schema",), ("instruktion",), ("revisionspläne",)]),
    ("Service", "Labour", "Labour / daywork", "UNKNOWN",
     [("regie",), ("stunden",), ("monteur",)]),
    ("Service", "Transport", "Shipping and handling", "UNKNOWN",
     [("versandkosten",), ("fracht",), ("transport",)]),
    ("Other", "Labelling", "Labelling", "UNKNOWN",
     [("farbpfeil",), ("beschriftung",), ("schild",), ("farbbeschichtung",)]),
    # generic pipe last
    ("Pipework", "Pipe", "Pipe", "PIPE",
     [("rohr",), ("leitung",)]),
]

def _shared_trades(r) -> tuple:
    # pipes, water valves, pipe collars and pipe insulation do not exist in ventilation:
    # there "Rohr" is a round duct and "Ventil" an air valve
    if r[0] in ("Pipework", "Valves") or r[1] in ("Fire collar", "Pipe insulation"):
        return (H, S)
    return ALL


RULES: list[Rule] = (
    [Rule((V,), *r) for r in _VENT] + [Rule((H,), *r) for r in _HEAT] + [Rule((S,), *r) for r in _SAN]
    + [Rule(_shared_trades(r), *r) for r in _SHARED] + [Rule((V,), *r) for r in _VENT_TAIL]
)

AIR_SIDE = [("supply", ("zuluft", "zul ")), ("exhaust", ("abluft", "abl ")),
            ("outdoor", ("aussenluft", "aul ")), ("exhaust_out", ("fortluft", "fol "))]

# ---------------------------------------------------------------- German -> English attributes
# (regex on lower-case German text, English word). First match per group wins.
ATTRIBUTES = {
    "material": [
        (r"chromnickelstahl|chromstahl|edelstahl|inox|v2a|v4a|1\.4\d{3}", "stainless steel"),
        (r"verzinkt", "galvanized"),
        (r"kupfer", "copper"),
        (r"\bguss|gusseisen", "cast iron"),
        (r"mineralwolle|steinwolle", "mineral wool"),
        (r"aluminium|\balu\b|alu-", "aluminium"),
        (r"mehrschicht|verbund", "multilayer"),
        (r"\bpe\b|pe-|polyethylen", "PE"),
        (r"\bpp\b|pp-|polypropylen", "PP"),
        (r"pvc", "PVC"),
        (r"kunststoff", "plastic"),
        (r"keramik|porzellan|sanitärporzellan", "ceramic"),
        (r"\bstahl", "steel"),
    ],
    "feature": [
        (r"luftmengeneinstellung|mengeneinstellung", "airflow adjustable"),
        (r"kompakt", "compact"),
        (r"mit antrieb|stellantrieb|motorisch|mit motor", "with actuator"),
        (r"modbus", "Modbus"),
        (r"bacnet", "BACnet"),
        (r"wetterfest", "weatherproof"),
        (r"doppelwandig", "double-walled"),
        (r"wandhängend|wandmontage|wand-wc|wandmodell", "wall-hung"),
        (r"bodenstehend|standmodell", "floor-standing"),
        (r"unterputz", "concealed"),
        (r"aufputz", "surface-mounted"),
        (r"selbstschluss|selbstschliessend", "self-closing"),
        (r"berührungslos|infrarot|sensorgesteuert", "touchless"),
        (r"einhebel", "single-lever"),
        (r"thermostatisch|thermostat", "thermostatic"),
        (r"behindertengerecht|hindernisfrei|rollstuhl", "barrier-free"),
        (r"brennwert", "condensing"),
        (r"luft/wasser|luft-wasser", "air-to-water"),
        (r"sole/wasser|sole-wasser", "brine-to-water"),
        (r"hocheffizienz|ec-motor|drehzahlgeregelt", "high-efficiency"),
        (r"eckig|rechteckig", "rectangular"),
        (r"gedämmt|isoliert", "insulated"),
        (r"diffusionsdicht|dampfdicht", "vapour-tight"),
    ],
}
SPEC_PATTERNS = [   # numeric specs worth keeping in the English description
    (re.compile(r"(\d+(?:[.,]\d+)?)\s*kW\b", re.I), "{} kW"),
    (re.compile(r"(\d{2,5})\s*(?:l|liter|litre)\b", re.I), "{} l"),
    (re.compile(r"\bPN\s?(\d{1,2})\b", re.I), "PN{}"),
]
INCH_TO_DN = {"1/4": 8, "3/8": 10, "1/2": 15, "3/4": 20, "1": 25, "1 1/4": 32, "1 1/2": 40, "2": 50,
              "2 1/2": 65, "3": 80, "4": 100}


# ---------------------------------------------------------------- learned from the LLM
# The LLM step (llm_understand.py) writes every confident reading to vocab_learned.json. classify() checks
# these learned entries BEFORE the hand-written RULES, so when the LLM is unreachable the rules-only
# fallback already knows every position the LLM has read before.
#   phrase    normalised German position title, e.g. "zuluft tellerventil"  (whole-word match)
#   keywords  distinctive German words the LLM cited as evidence             (all must appear)
import json as _json
import os as _os
from pathlib import Path as _Path

LEARNED_PATH = _Path(_os.environ.get("BIDWISE_LEARNED") or _Path(__file__).resolve().parent.parent / "vocab_learned.json")
LEARNED: list[dict] = []
_STOP = {"grösse", "groesse", "fabrikat", "material", "inkl", "inklusive", "liefern", "montieren", "montage",
         "gemäss", "gemass", "nach", "oder", "und", "mit", "ohne", "aus", "für", "fur", "pro", "stück", "stk",
         "typ", "farbe", "ausführung", "ausfuhrung", "lieferung", "einbau", "sowie", "wunsch", "architekten"}


def norm_de(text: str) -> str:
    """lower case, letters only, no numbers / sizes / stop words: 'Zuluft - Tellerventil Ø 10 cm' -> 'zuluft tellerventil'"""
    words = re.findall(r"[a-zäöüß]+", str(text).lower())
    return " ".join(w for w in words if len(w) > 2 and w not in _STOP)


def load_learned(path=None) -> list[dict]:
    global LEARNED, LEARNED_PATH
    if path is not None:
        LEARNED_PATH = _Path(path)
    try:
        LEARNED = _json.loads(LEARNED_PATH.read_text(encoding="utf-8")) if LEARNED_PATH.exists() else []
    except Exception:
        LEARNED = []
    return LEARNED


def learned_lookup(text: str, trade: str | None = None):
    """-> (category, subcategory, english, install_code) from the learned vocabulary, or None.
    Longest matching title phrase wins; then evidence keywords."""
    t = f" {norm_de(text)} "
    best = None
    for e in LEARNED:
        if trade and e.get("trade") not in (None, trade):
            continue
        ph = e.get("phrase") or ""
        if ph and f" {ph} " in t and (best is None or len(ph) > len(best.get("phrase") or "")):
            best = e
    if best is None:
        for e in LEARNED:
            if trade and e.get("trade") not in (None, trade):
                continue
            kws = e.get("keywords") or []
            if kws and all(f" {k} " in t or k in t for k in kws):
                best = e
                break
    if best is None:
        return None
    return best["category"], best["subcategory"], best["english"], best.get("install_code") or "UNKNOWN"


def learn(entries: list[dict], path=None) -> int:
    """Merge LLM readings into vocab_learned.json. Same phrase + trade: counts per reading, the most
    frequent reading wins. Returns the number of new or changed entries."""
    load_learned(path)
    index = {(e.get("trade"), e.get("phrase"), tuple(e.get("keywords") or [])): e for e in LEARNED}
    changed = 0
    for n in entries:
        k = (n.get("trade"), n.get("phrase"), tuple(n.get("keywords") or []))
        cur = index.get(k)
        reading = f"{n['category']}|{n['subcategory']}|{n['english']}"
        if cur is None:
            n = {**n, "votes": {reading: 1}}
            LEARNED.append(n); index[k] = n; changed += 1
            continue
        votes = cur.setdefault("votes", {})
        votes[reading] = votes.get(reading, 0) + 1
        top = max(votes, key=votes.get)
        if top != f"{cur['category']}|{cur['subcategory']}|{cur['english']}":
            cur["category"], cur["subcategory"], cur["english"] = top.split("|", 2)
            cur["install_code"] = n.get("install_code") if top == reading else cur.get("install_code")
            changed += 1
    LEARNED_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEARNED_PATH.write_text(_json.dumps(LEARNED, ensure_ascii=False, indent=1), encoding="utf-8")
    return changed


load_learned()
