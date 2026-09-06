// Sorting a travel document into a folder, from whatever text we have for it: the
// file name, and — when the device managed to read it — the document's own text
// (a PDF's text layer, or OCR of a photo). Pure and DOM-free on purpose: the same
// file runs in the browser (window.DocClassify) and in node
// (tools/docs-classify-check.js), so the fixtures the check runs are the exact rules
// the page runs. Nothing here touches the network; the text never leaves the device.
//
// How it decides: every folder has a list of clues, each a regex with a weight.
//   4 — names the document type on its own ("boarding pass", "פוליסה", a passport MRZ line)
//   3 — strong: an airport code, an insurer, a rental brand, "check-out"
//   2 — typical of the type, but seen elsewhere too ("hotel", "gate", "Mr")
//   1 — a hint that only adds up with others ("total", "confirmation")
// A clue counts once, plus half again when it matches a second distinct way (three
// airport codes on a ticket outrank a hotel that mentions the airport shuttle). The
// folder with the highest total wins; a tie goes to the earlier folder in the list.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DocClassify = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const FOLDERS = [
    { key: 'flights', name: 'טיסות', emoji: '✈️' },
    { key: 'id', name: 'דרכון וזהות', emoji: '🛂' },
    { key: 'stay', name: 'לינה', emoji: '🏨' },
    { key: 'insurance', name: 'ביטוח', emoji: '🛡️' },
    { key: 'car', name: 'רכב ותחבורה', emoji: '🚗' },
    { key: 'health', name: 'בריאות', emoji: '💊' },
    { key: 'money', name: 'כסף וקבלות', emoji: '🧾' },
    { key: 'other', name: 'אחר', emoji: '📄' },
  ];

  // Airport codes an Israeli traveller's ticket realistically carries. Uppercase only
  // (OCR keeps case, and tickets print codes in caps). Codes that are also plain
  // English words in caps — BUS, ADD, MAN, SIN, HER, DEL, SAW, NAP, LIM, MRS, BOM,
  // LAX-like are fine — are left out of the standalone list and only count in a
  // route pair ("TLV-BUS"), where the other half vouches for them.
  const IATA = 'TLV|ETM|VDA|SDV|HFA|LCA|PFO|ATH|SKG|HER|RHO|JTR|JMK|KGS|CFU|CHQ|ZTH|IST|SAW|AYT|ADB|DLM|BJV|BUD|PRG|VIE|WAW|KRK|GDN|WRO|BER|MUC|FRA|DUS|HAM|STR|CGN|CDG|ORY|MRS|NCE|LYS|LHR|LGW|STN|LTN|MAN|EDI|DUB|AMS|BRU|ZRH|GVA|BSL|FCO|CIA|MXP|LIN|BGY|VCE|NAP|BLQ|FLO|PSA|CTA|PMO|CAG|MAD|BCN|PMI|AGP|VLC|SVQ|ALC|IBZ|LIS|OPO|FAO|CPH|ARN|GOT|OSL|HEL|SOF|VAR|BOJ|OTP|CLJ|BEG|TIV|TGD|DBV|SPU|ZAG|LJU|SJJ|SKP|TIA|TBS|BUS|KUT|EVN|GYD|BAK|JFK|EWR|LGA|LAX|SFO|MIA|MCO|FLL|BOS|ORD|IAD|DCA|ATL|DFW|IAH|LAS|SEA|DEN|PHL|YYZ|YUL|YVR|BKK|DMK|HKT|CNX|USM|SIN|KUL|DPS|CGK|NRT|HND|KIX|ICN|HKG|TPE|MNL|HAN|SGN|DAD|DEL|BOM|GOI|COK|CMB|MLE|KTM|DXB|AUH|DOH|BAH|AMM|CAI|SSH|HRG|MRA|ADD|NBO|ZNZ|JNB|CPT|SEZ|MRU|RUN|MEX|CUN|GRU|GIG|EZE|LIM|BOG|SCL|UIO|SJO|PTY|HAV|SYD|MEL|BNE|AKL|MLA|LPA|TFS|TFN|FNC|ACE|FUE|KEF|RIX|VNO|TLL|LED|SVO|DME|KBP|TAS|ALA|NQZ|FRU';
  const IATA_WORDY = /^(?:BUS|ADD|MAN|SIN|HER|DEL|SAW|NAP|LIM|MRS|BOM|RUN|ACE|FLO|LAS|CIA|USM|MCO|DCA)$/;
  const IATA_SAFE = IATA.split('|').filter((c) => !IATA_WORDY.test(c)).join('|');
  const RE_IATA = new RegExp(`\\b(?:${IATA_SAFE})\\b`);
  const RE_ROUTE = new RegExp(`\\b(?:${IATA})\\s?(?:-|–|—|→|>|to|\\/|–>|->)\\s?(?:${IATA})\\b`);
  // two-letter airline codes + a flight number, uppercase — the codes that also
  // read as words or units (AM, PM, AC, TO, LA, OK, CA, MS…) stay out
  const RE_FLIGHT_NO = /\b(?:LY|6H|IZ|W6|W4|FR|U2|EJU|LH|TK|PC|A3|EK|EY|QR|DL|UA|AA|BA|AF|KL|LX|OS|SN|AZ|IB|TP|LO|UX|VY|HV|DY|D8|SK|AY|ET|AI|CX|SQ|TG|KE|JL|NH|B6|WN|LS|EI|RJ|WY|GF|SV|MH|GA|VN|OZ|UL|QF|NZ|VA|S7|SU|KC|HY|MU|CZ|FB|RO|JU|BT|OA|A9|J2|XQ|XY|F3|G9|ZB|OU|JP|TB|FZ|PK|BG|9W|4O|3O|7C|LJ|TW|ZE|VJ|QZ|AK|FD|OD|6E|SG|UK|IX|WS|PD|TS|F9|NK|B6|G4|SY|HA|VS|BE|LM|EW|DE|X3|4U|OE|VL|EN|LG|VE|HU|GS|3U|ZH|SC|8L|PN)\s?\d{2,4}\b/;
  const RE_ETICKET_NO = /\b\d{3}[- ]?\d{10}\b/; // 13-digit e-ticket number, "114-1234567890"
  const RE_PNR = /\bPNR\b|record locator|\b(?:booking reference|reservation code|airline reference|confirmation code|reference number)\b[:\s#]*[A-Z0-9]{5,7}\b/i;
  // passport machine-readable zone: "P<ISRCOHEN<<DAVID<<<<…" or the 44-char second line
  const RE_MRZ = /P[A-Z<][A-Z]{3}[A-Z<]{6,}|[A-Z0-9<]{9}\d[A-Z]{3}\d{7}|<<<<+/;

  // [regex, weight, label]. Labels are what the sheet shows as the reason ("TLV", "פוליסה");
  // without one, the matched text is shown. Hebrew clues are plain substrings: \b does
  // not understand Hebrew letters, and prefixes (ה, ב, ל) make exact words wrong anyway.
  const RULES = {
    flights: [
      [/boarding\s*pass|כרטיס עלי+ה למטוס|עלי+ה למטוס|boarding card/i, 4, 'Boarding pass'],
      [/\be-?tickets?\b|electronic ticket|itinerary receipt|flight itinerary|e-?ticket receipt|כרטיס טיסה|כרטיסי טיסה|אישור טיסה|פרטי הטיסה/i, 4, 'E-ticket'],
      [RE_ROUTE, 4, 'route'],
      [RE_IATA, 3],
      [RE_FLIGHT_NO, 3, 'flight number'],
      [RE_ETICKET_NO, 3, 'ticket number'],
      [RE_PNR, 3, 'PNR'],
      [/\bEl[ -]?Al\b|אל[ -]?על|Israir|ישראייר|Arkia|ארקיע|Wizz\s?Air|\bWizz\b|Ryanair|easyJet|Lufthansa|Turkish Airlines|Pegasus|Aegean|Olympic Air|Etihad|Qatar Airways|Emirates Airline|\bfly ?Emirates|Air France|\bKLM\b|British Airways|Swiss International|\bSWISS\b|Austrian Airlines|Brussels Airlines|ITA Airways|Alitalia|\bIberia\b|TAP (?:Air )?Portugal|LOT Polish|Air Europa|Vueling|Transavia|Norwegian Air|Finnair|Ethiopian Airlines|Air India|Cathay Pacific|Singapore Airlines|Thai Airways|Korean Air|Japan Airlines|Air Canada|United Airlines|Delta Air ?Lines|American Airlines|Sun ?d'?Or|Blue ?Bird Airways|Bulgaria Air|\bTarom\b|Air Serbia|airBaltic|Smartwings|Corendon|SunExpress|flydubai|Air Arabia|Royal Jordanian|Air Seychelles|Hainan Airlines|China Eastern|Air Astana|Uzbekistan Airways|Georgian Airways|Azerbaijan Airlines|\bAZAL\b|Eurowings|Condor|TUI ?fly|Jet2|Aer Lingus|Icelandair|Air Malta|KM Malta|Cyprus Airways|TUS Airways|Air Haifa|Sundor|Volotea|Level\b airline|Ryan ?Air|Wizzair/i, 3, 'airline'],
      [/Ben[ -]Gurion|נתב"ג|נתב״ג|נתבג|שדה[ -]התעופה|שדה תעופה|\bairport\b|Heathrow|Gatwick|Stansted|Luton|Charles de Gaulle|Schiphol|Fiumicino|Malpensa|Barajas|El Prat|Ataturk|Sabiha|Sabiha Gök|Larnaca Airport|Eleftherios|Ramon Airport|שדה התעופה רמון/i, 2, 'airport'],
      [/\bflights?\b|טיסה|טיסות|טיסת|הטיסה/i, 2, 'flight'],
      [/\bairlines?\b|\bair ?ways\b|חברת התעופה|חברת תעופה|carrier|operated by|מופעל(?:ת)? על ידי/i, 2, 'airline'],
      // passengers and seats ride trains and buses too — on a flight they never come alone
      [/\bpassengers?\b|\bpax\b|traveller|traveler|נוסע|נוסעת|נוסעים|שם הנוסע/i, 1, 'passenger'],
      [/\b(?:MR|MRS|MS|MSTR|MISS|CHD|INF|ADT|DR)\b(?=[\s/,.]|$)/, 2, 'Mr'],
      [/\bM(?:r|rs|s|iss)\.?\s+[A-Z]/, 1, 'Mr'],
      [/boarding (?:time|group|gate|zone)|\bgates?\b|שער עלי+ה|שער יציאה|boarding zone|\bzone \d|\bgroup \d/i, 2, 'gate'],
      [/\bseats?\b|seat (?:number|no|assignment|selection)|מושב|מושבים/i, 1, 'seat'],
      [/\bdeparture\b|\bdepart(?:s|ing|ure time)?\b|\barrival\b|\barriv(?:es|ing)\b|המראה|נחיתה|יציאה מ|הגעה ל|\bETD\b|\bETA\b|\bSTD\b|\bSTA\b/i, 1, 'departure'],
      [/baggage|luggage|carry-?on|cabin bag|hand bag|checked bag|hold bag|\btrolley\b|priority boarding|כבודה|מזוודה|מזוודות|טרולי|מטען יד|תיק יד|מטען|\b\d{1,2}\s?kg\b|\bkg\b/i, 2, 'baggage'],
      [/\bterminal\s?\d?\b|טרמינל/i, 1, 'terminal'],
      [/economy|business class|premium economy|first class|fare (?:type|class|rules|basis|family)|light fare|basic fare|flex fare|standard fare|מחלקת תיירים|מחלקת עסקים|מחלקה ראשונה|booking class|\bclass\s?[A-Z]\b/i, 2, 'fare'],
      [/online check-?in|web check-?in|check-?in (?:opens|closes|counter|desk)|check-?in time|צ'ק-?אין מקוון|צ׳ק-?אין מקוון|דלפק/i, 2, 'check-in'],
      [/frequent flyer|\bmiles\b|mileage plus|matmid|מתמיד|נוסע מתמיד|\bIATA\b|\bICAO\b|\bETKT\b|\bTKT\b|\bSSR\b|\bstopover\b|\blayover\b|\bconnection\b|non-?stop|direct flight|round ?trip|one ?way|הלוך ושוב|הלוך וחזור|כיוון אחד|עצירת ביניים|קונקשן|טיסה ישירה/i, 2, 'flight terms'],
      [/\btickets?\b|כרטיס(?!\s*אשראי)|כרטיסים/i, 1, 'ticket'],
      [/\blounge\b|fast ?track|\bpriority\b|\bduty ?free\b|דיוטי פרי|\bTSA\b|\bsecurity check/i, 1, 'airport'],
    ],
    id: [
      [/\bpassports?\b|דרכון|דרכונים|PASSEPORT|PASAPORTE|REISEPASS|PASSAPORTO/i, 4, 'passport'],
      [RE_MRZ, 4, 'MRZ'],
      [/visa (?:application|number|no|type|valid|on arrival|waiver|fee|category|status|grant|approved)|tourist visa|entry visa|multiple entry|single entry|e-?visa\b|visa waiver|ויזה|אשרת כניסה|אשרת שהייה|אשרה|אשרת תייר/i, 4, 'visa'],
      [/\bESTA\b|\beTA\b|\bETIAS\b|\bK-ETA\b|\bETA\s?(?:Canada|Australia)/, 4, 'ESTA'],
      [/\bvisa\b(?! (?:card|ending|debit|credit|\*+|xxxx|\d{4}))/i, 2, 'visa'],
      [/Schengen|שנגן|entry permit|היתר כניסה|Immigration|הגירה|ביקורת גבולות|border control|\bcustoms declaration|arrival card|landing card|departure card|\bTAP\b form|Home Office|Department of State|Embassy|Consulate|שגרירות|קונסוליה/i, 3, 'immigration'],
      [/תעודת זהות|ת\.?ז\.?\s*:?\s*\d|מספר זהות|מס'? זהות|מספר ת"ז|identity card|national id|\bID card\b|\bID number\b|ID No\.?|personal (?:no|number)|מדינת ישראל|State of Israel|משרד הפנים|Ministry of (?:the )?Interior|רשות האוכלוסין|Population (?:and Immigration )?Authority|ספח|תעודה מזהה/i, 3, 'identity'],
      [/nationality|אזרחות|לאום|date of birth|תאריך לידה|place of birth|מקום לידה|date of issue|תאריך הנפקה|date of expiry|expiry date|תאריך תפוגה|בתוקף עד|\bsurname\b|given names?|שם משפחה|שם פרטי|issuing authority|רשות מנפיקה|\bsex\b|מין\b|\bholder'?s? signature|חתימת בעל/i, 1, 'personal details'],
      [/driv(?:ing|er'?s?) licen[cs]e|רישיון נהיגה|רשיון נהיגה|international driving permit|\bIDP\b|driving permit|permis de conduire|Führerschein|patente di guida|\bDL number|licen[cs]e (?:number|no|class)/i, 4, 'driving licence'],
      [/birth certificate|תעודת לידה|marriage certificate|תעודת נישואין|תעודת|certificate of (?:citizenship|naturali)|תעודת עולה|תעודת מילואים|תעודת חוגר|תעודת סטודנט|student (?:id|card)|\bISIC\b/i, 2, 'certificate'],
      [/\bidentity\b|\bID\b|\bIDs\b|זהות|\bpassport photo/i, 1, 'ID'],
    ],
    stay: [
      [/Booking\.com|Agoda|Hotels\.com|Airbnb|\bVrbo\b|Trivago|\bHRS\b|Hostelworld|Marriott|Hilton|Hyatt|\bAccor\b|\bIbis\b|Novotel|Mercure|Radisson|Holiday Inn|Best Western|Sheraton|InterContinental|Kempinski|Four Seasons|Ritz-?Carlton|Isrotel|ישרוטל|Fattal|פתאל|Leonardo Hotels?|לאונרדו|Dan Hotels|מלונות דן|Atlas Hotels|Brown Hotels|Prima Hotels|Rimonim|רימונים|Club Hotel|Herbert Samuel|Selina|Generator Hostel|Meininger|a&o Hostel|Motel One|Premier Inn|Travelodge|NH Hotels|Melia|Meliá|Barceló|Barcelo|RIU\b|Iberostar|Wyndham|Crowne Plaza|Doubletree|Hampton Inn|Moxy|citizenM/i, 3, 'hotel chain'],
      [/Expedia|Trip\.com|\bKayak\b|Priceline|Hotwire|Orbitz|Travelocity|eDreams|Lastminute|Gotogate|Opodo/i, 2, 'booking site'],
      [/\bhotels?\b|מלון|מלונות|בית מלון|בתי מלון/i, 2, 'hotel'],
      [/\bhostels?\b|אכסני|\bresort\b|\bapartments?\b|דירת נופש|דירה|guest ?house|\bB&B\b|bed (?:and|&) breakfast|\bvillas?\b|וילה|צימר|צימרים|אירוח|accommodation|לינה|aparthotel|ryokan|\briad\b|\bmotel\b|\blodge\b|\bchalet\b|\bcabin\b|בקתה|\bsuite\b|סוויטה|\bpension\b|פנסיון|\bagriturismo\b|\bhomestay\b/i, 3, 'accommodation'],
      [/check-?in\b|צ'ק[- ]?אין|צ׳ק[- ]?אין|כניסה לחדר|arrival date|תאריך הגעה/i, 2, 'check-in'],
      [/check-?out\b|צ'ק[- ]?אאוט|צ׳ק[- ]?אאוט|יציאה מהחדר|departure date|תאריך עזיבה|late check-?out|early check-?in/i, 3, 'check-out'],
      [/\bnights?\b|לילות|לילה|\bstay\b|שהות|שהייה|\brooms?\b|room (?:type|only|rate|number|no)|חדר|חדרים|double room|twin room|single room|family room|dorm|king bed|queen bed|twin beds|מיטה זוגית|מיטות|מיטה/i, 2, 'nights/room'],
      [/breakfast included|ארוחת בוקר|half board|full board|all inclusive|הכל כלול|חצי פנסיון|פנסיון מלא|bed & breakfast|room only|self catering/i, 2, 'board'],
      [/\bguests?\b|אורח|אורחים|\badults?\b|מבוגרים|\bchildren\b|ילדים|occupancy|\breception\b|קבלה 24|front desk|kitchenette|מטבחון|\bwi-?fi\b|\bpool\b|בריכה|\bspa\b|\bbalcony\b|מרפסת|sea view|נוף לים|city view|\bamenities\b|house rules|host\b|מארח|מארחת|\bproperty\b|הנכס|address of the property|כתובת המלון|\bstars?\b|כוכבים/i, 1, 'guests'],
      [/free cancellation|non-?refundable|cancellation policy|ביטול חינם|ללא החזר|מדיניות ביטול|\bdeposit\b|פיקדון|city tax|tourist tax|מס עירוני|resort fee|מס תיירים/i, 1, 'policy'],
      [/confirmation (?:number|no|code)|booking (?:number|no|id|confirmation)|reservation (?:number|no|id|confirmed|details)|\breservation\b|\breserved\b|הזמנה מס|מספר הזמנה|אישור הזמנה|הזמנה|הזמנת|\bconfirm(?:ed|ation)?\b|אישור/i, 1, 'confirmation'],
    ],
    insurance: [
      [/travel insurance|ביטוח נסיעות|ביטוח נסיעות לחו"ל|ביטוח נסיעות לחו״ל|ביטוח לחו"ל|ביטוח לחו״ל|medical insurance|ביטוח רפואי|ביטוח בריאות|trip cancellation|ביטול נסיעה|travel protection|travel cover|policy schedule|policy wording|certificate of insurance|רשימת הפוליסה|תנאי הפוליסה|דף פרטי ביטוח|דף הרשימה|insurance certificate|assurance voyage/i, 4, 'travel insurance'],
      [/\binsurance\b|\binsured\b|ביטוח|ביטוחי|מבוטח|המבוטח|מבוטחת|\bassurance\b|Versicherung|assicurazione|\bseguro\b/i, 3, 'insurance'],
      [/\bpolicy\b|\bpolicies\b|פוליסה|פוליסת|מספר פוליסה|policyholder|policy (?:number|no|holder|period|start|end)|\binsurer\b|המבטח|המבטחת|underwrit/i, 3, 'policy'],
      [/coverage|\bcover(?:ed|s)?\b (?:for|up to|includes)|כיסוי|כיסויים|\bpremium\b|פרמיה|דמי ביטוח|\bdeductible\b|\bexcess\b|השתתפות עצמית|\bclaims?\b|תביעה|תביעות|beneficiar|מוטב|מוטבים|emergency assistance|24\/7 assistance|assistance (?:number|line|company|centre|center)|מוקד חירום|מוקד 24|sum insured|סכום ביטוח|גבול אחריות|limit of liability|\bindemnity\b|\bendorsement\b|\bexclusions?\b|חריגים|תקופת הביטוח|period of (?:insurance|cover)/i, 2, 'coverage'],
      [/\bHarel\b|הראל|\bMigdal\b|Phoenix Insurance|הפניקס|Clal Insurance|כלל ביטוח|\bMenora\b|מנורה מבטחים|\bAyalon\b|איילון|Hachshara|הכשרה|PassportCard|פספורט ?קארד|\bAIG\b|Allianz|\bAXA\b|Generali|Zurich Insurance|\bChubb\b|Europ Assistance|World Nomads|SafetyWing|Heymondo|Insubuy|IMG Global|Travelex Insurance|\bBupa\b|\bCigna\b|\bAetna\b|Mapfre|\bERGO\b|Hepstar|battleface|Faye Travel|\bTugo\b|Manulife|Sun Life|Lloyd'?s|Direct Insurance|ביטוח ישיר|\b9 ?מיליון|שלמה ביטוח|ליברה|\bLibra\b|וישור|\bWesure\b|כלמוביל|Magen David Adom|מגן דוד אדום|\bMDA\b/i, 3, 'insurer'],
      [/medical expenses|הוצאות רפואיות|hospitali[sz]ation|אשפוז|repatriation|evacuation|פינוי|החזרה לישראל|הטסה רפואית|baggage (?:loss|delay)|lost luggage|אובדן כבודה|איחור כבודה|flight delay|missed connection|personal liability|צד שלישי|extreme sports|ספורט אתגרי|winter sports|ספורט חורף|pre-?existing|מצב רפואי קודם|search and rescue|חיפוש והצלה|dental emergency|רופא שיניים|\bpregnancy cover|הריון|laptop cover|\bmobile phone cover|החמרה של מצב/i, 3, 'cover'],
    ],
    car: [
      [/car (?:rental|hire)|rent-?a-?car|rental (?:agreement|car|voucher|confirmation|contract|period|company)|hire agreement|\bvehicle\b|השכרת רכב|השכרת הרכב|חוזה שכירות|רכב שכור|רכב להשכרה|השכרה|rental vehicle|\bcar\b/i, 4, 'car rental'],
      [/\bHertz\b|\bSixt\b|Europcar|Budget (?:Rent|Car)|Enterprise (?:Rent|Car)|\bAlamo\b|\bThrifty\b|Dollar (?:Rent|Car)|National Car|\bGoldcar\b|\bFirefly\b|\bKeddy\b|\bEldan\b|אלדן|Shlomo Sixt|שלמה סיקסט|סיקסט|Discover ?Cars|Rentalcars|Auto ?Europe|Economy Bookings|\bTuro\b|Getaround|Localiza|\bCentauro\b|Ok Mobility|Record Go|Drivalia|Maggiore|Locauto|Noleggiare|\bAvis\b|Cal Auto|קל אוטו|\bTamir\b|תמיר|Green Motion|Surprice|Payless|Zipcar|Leo ?Cars|Autounion|Wheels|Yango|Bolt|\bUber\b|\bGett\b|Free ?Now|Cabify|\bLyft\b|\bGrab\b|מונית|\btaxi\b/i, 3, 'rental brand'],
      [/pick-?up (?:date|time|location|point|branch)|drop-?off|return (?:date|time|location|branch)|\bcollection\b|איסוף הרכב|החזרת הרכב|החזרה|מיקום איסוף|\bdrivers?\b|\bdriver'?s\b|additional driver|נהג נוסף|נהג|נהגת|license plate|plate number|לוחית רישוי|מספר רישוי|\bmileage\b|kilomet|\bfuel\b|fuel policy|full to full|דלק|ק"מ|ק״מ|קילומטר|\bodometer\b|\bchild seat\b|כיסא בטיחות|\bGPS\b|\bnavigation\b|\bautomatic\b|\bmanual transmission|אוטומט|ידני|\bcompact\b|\bSUV\b|\bsedan\b|מיני-?בוס|\bvan\b/i, 2, 'pick-up/driver'],
      [/\bCDW\b|collision damage|theft protection|\bTP\b waiver|\bSCDW\b|super cover|damage waiver|\bLDW\b|roadside assistance|\bADAC\b|\bexcess\b reduction|ביטוח רכב|ביטוח לרכב|\bdamage\b|נזק|third party liability|\bTPL\b/i, 3, 'car cover'],
      [/\bparking\b|חניה|חנייה|חניון|\btolls?\b|כביש אגרה|כביש 6|\bvignette\b|ויניטה|\bcongestion charge|\bZTL\b|\bspeed(?:ing)? (?:fine|ticket)|דו"ח תנועה|קנס תנועה|traffic fine/i, 2, 'parking/toll'],
      [/\btrains?\b|\brailways?\b|\brail\b|Trenitalia|\bItalo\b|Eurostar|Thalys|Deutsche Bahn|DB Navigator|DB Fernverkehr|\bSNCF\b|\bTGV\b|\bOUIGO\b|\bRenfe\b|\bAVE\b train|Eurail|Interrail|\bÖBB\b|\bOBB\b|\bSBB\b|\bCFF\b|\bNS International|Omio|Trainline|Rail ?Europe|רכבת|רכבת ישראל|Israel Railways|\bAmtrak\b|\bJR Pass\b|Shinkansen|\bKTX\b|\bmetro\b|\bsubway\b|\btram\b|\bunderground\b/i, 4, 'train'],
      [/\bplatform\b|רציף|\bcarriage\b|\bcoach \d|קרון|\bTermini\b|S\.M\.N|Hauptbahnhof|\bHbf\b|Gare d[eu']|St\.? Pancras|\bCentraal\b|Estaci[oó]n|\bStazione\b|\bstation\b|תחנת רכבת|תחנה מרכזית/i, 2, 'station'],
      [/FlixBus|Flix ?Bus|BlaBlaCar|BlaBlaBus|Eurolines|\bMegabus\b|\bGreyhound\b|\bALSA\b|אוטובוס|bus ticket|coach ticket|\bEgged\b|אגד|\bDan\b bus|\bKavim\b|קווים|\bMetropoline\b|מטרופולין|\bSuperbus\b/i, 4, 'bus'],
      [/\bbus\b|\bshuttle\b|שאטל|הסעה|הסעות|\btransfer\b(?! (?:fee|of funds|to account))|airport transfer|העברה משדה|\bcoach\b|\bminibus\b/i, 1, 'transfer'],
      [/\bferry\b|\bferries\b|\bboat\b|\bcruise\b|מעבורת|שייט|Blue Star|Hellenic Seaways|SeaJets|Minoan|\bANEK\b|\bport of\b|\bharbou?r\b|נמל|\bdeck\b|\bcabin\b class|MSC Cruises|Royal Caribbean|Costa Cruises|Norwegian Cruise|\bMano\b|מנו ספנות/i, 2, 'ferry/cruise'],
      [/metro card|travel ?card|transit pass|day pass|\bOyster\b|\bNavigo\b|\bSuica\b|\bPasmo\b|\bOctopus card|Rav-?Kav|רב-?קו|\bBVG\b|\bTfL\b|\bRATP\b|\bMVV\b|\bWiener Linien|\bATM Milano/i, 2, 'transit'],
      [/\bvouchers?\b|שובר|שוברים/i, 1, 'voucher'],
    ],
    health: [
      [/vaccin|immuni[sz]|חיסון|חיסונים|פנקס חיסונים|yellow fever|קדחת צהובה|\btyphoid\b|hepatitis|\brabies\b|\bmalaria\b|מלריה|\btetanus\b|\bMMR\b|\bpolio\b|\bICVP\b|International Certificate of Vaccination|vaccination (?:card|certificate|record)|\bCDC\b|\bWHO\b|תעודת מחלים|\bgreen pass\b|תו ירוק|EU Digital COVID|\bPCR\b|antigen test|בדיקת קורונה|fit to fly|health (?:certificate|declaration|pass|form)|הצהרת בריאות|\bprophylaxis\b|\bdengue\b|\bcholera\b|\bmeningitis\b|\bJapanese encephalitis/i, 4, 'vaccination'],
      [/\bprescriptions?\b|מרשם|מרשמים|\bRx\b|\bmedications?\b|\bmedicines?\b|תרופה|תרופות|תרופתי|\bdosage\b|מינון|\bpharmac(?:y|ies)\b|בית מרקחת|סופר-?פארם|Super-?Pharm|\btablets?\b|\bcapsules?\b|\bmg\b(?! ?\/)|\bml\b|\bEpiPen\b|\binhaler\b|משאף|\binsulin\b|אינסולין|\bgeneric name|\bbrand name|\bactive ingredient|חומר פעיל|\bcontraindicat|\bside effects|תופעות לוואי/i, 3, 'medication'],
      [/\bMaccabi\b|מכבי שירותי בריאות|מכבי|\bClalit\b|שירותי בריאות כללית|קופת חולים כללית|\bMeuhedet\b|מאוחדת|\bLeumit\b|לאומית|קופת חולים|קופ"ח|קופ״ח|\bHMO\b|\bNHS\b|Hadassah|הדסה|Ichilov|איכילוב|Sheba|שיבא|Tel Hashomer|תל השומר|Rambam|רמב"ם|Soroka|סורוקה|Beilinson|בילינסון|Assuta|אסותא|Shaare Zedek|שערי צדק|Wolfson|וולפסון|Meir Hospital|בית חולים מאיר|Terem|טרם/i, 3, 'HMO/hospital'],
      [/\bdoctors?\b|רופא|רופאה|\bphysician\b|\bclinic\b|מרפאה|\bhospital\b|בית חולים|בי"ח|\bpatient\b|מטופל|מטופלת|\bdiagnosis\b|אבחנה|medical (?:report|summary|record|history|condition|letter|file|opinion|note)|מסמך רפואי|סיכום רפואי|סיכום ביקור|דו"ח רפואי|מכתב רפואי|\bsymptoms?\b|תסמינים|\blab results?\b|בדיקות דם|blood test|\bMRI\b|\bCT scan|\bx-?ray\b|צילום רנטגן|\bultrasound\b|אולטרסאונד|\bECG\b|\bEKG\b|\bBMI\b|\bblood pressure|לחץ דם|\bdiabet|סוכרת|\bglucose\b|\basthma\b|אסטמה|\bepilep|אפילפסיה|\bcardiac|\bheart condition|\bpacemaker\b|קוצב לב|\bpregnan|הריון|\bdentist\b|רופא שיניים|\bophthalm|\boptician\b|\bhearing aid|\bwheelchair\b|כיסא גלגלים|\bmobility\b|נכות|\bdisabilit|\bcrutches\b/i, 2, 'medical'],
      [/\ballerg(?:y|ies|ic)\b|אלרגי|אלרגיה|blood type|סוג דם|\bgluten|\bceliac|צליאק|\blactose|לקטוז|\bpeanut|בוטנים|\bvegan\b|\bvegetarian\b|\bkosher\b|כשר|\bhalal\b/i, 2, 'allergy/diet'],
      [/\bCOVID\b|קורונה|\bcoronavirus\b|\bSARS-?CoV/i, 1, 'COVID'],
      [/\bDr\.\s|ד"ר|ד״ר|\bMD\b|\bM\.D\.|\bRN\b|\btreatment\b|טיפול|\btherapy\b|\bfirst aid\b|עזרה ראשונה|\bsunscreen\b|\bmosquito\b|יתושים|\bhydration|\bpainkiller|\bibuprofen|\bparacetamol|אקמול|\bAcamol\b|\bAdvil\b|\bNurofen\b|\bantibiotic|אנטיביוטיקה|\bantihistamine|\bmotion sickness|מחלת ים|\bjet ?lag|\bmelatonin|מלטונין|\bdiarrh|\bImodium\b|\bTravelan\b/i, 1, 'health'],
    ],
    money: [
      [/tax invoice|חשבונית מס|חשבונית מס\/קבלה|קבלה\/חשבונית|חשבונית עסקה|\bfattura\b|\bfactura\b|\bRechnung\b|\bfacture\b|\bricevuta\b|\breçu\b|\brecibo\b|\bQuittung\b|\bKassenbon\b|\bKassenzettel\b|\bBeleg\b|\bscontrino\b|\bnota fiscal\b|\bfiş\b|\bfatura\b/i, 4, 'invoice'],
      [/\breceipts?\b|קבלה|קבלות|\binvoices?\b|חשבונית|חשבוניות|\bproof of payment|אישור תשלום|payment (?:receipt|confirmation|received)|\bpaid in full\b|\bpaid\b|שולם|payment successful|התשלום בוצע|\bcredit note\b|\bdebit note\b/i, 3, 'receipt'],
      [/tax refund|VAT refund|Tax ?Free|טקס פרי|החזר מס|החזר מע"מ|\bGlobal Blue|\bPlanet Tax|\bPremier Tax Free|\bTax Free Form|\bdetaxe\b|\bdétaxe\b/i, 3, 'tax refund'],
      [/\bVAT\b|מע"מ|מע״מ|מעמ\b|\bIVA\b|\bTVA\b|\bMwSt\b|\bUSt\b|\bGST\b|\bHST\b|sales tax|\btax(?:es)?\b|\bcustoms\b|מכס|\bduty\b/i, 2, 'tax'],
      [/\bsubtotal\b|\bsub-?total\b|\bqty\b|\bquantity\b|unit price|מחיר ליחידה|כמות|\bitems?\b|פריט|פריטים|\bdiscount\b|הנחה|\bcoupon\b|קופון|\bpromo code|\bchange due\b|\bcash\b|מזומן|\btip\b|\bgratuity\b|טיפ|תשר|service charge|דמי שירות|\btable\s?\d|שולחן|\bwaiter\b|\bserver:|\bcashier\b|קופאי|קופה|\bregister\b|\bterminal id\b|\bmerchant\b|\bauth(?:orization)? code|\bapproval code|קוד אישור|\bcard (?:ending|number)|כרטיס אשראי|\bxxxx|\*{4}\s?\d{4}|\d{4}\s?\*{4}/i, 2, 'receipt items'],
      [/total (?:paid|amount|due|price|charged|cost|payable)|amount (?:paid|due|charged|payable)|grand total|\btotal\b|סה"כ|סה״כ|סהכ|סך הכל|סך הכול|לתשלום|\bbalance\b|יתרה|\bpayment\b|תשלום|תשלומים|אמצעי תשלום|payment method|\brefund\b|החזר כספי|זיכוי|\btransaction\b|עסקה|\bpurchase\b|רכישה|קנייה|\border (?:number|no|id|summary|total)\b|מספר הזמנה|\bprice\b|מחיר|\bcharge\b|\bfee\b|עמלה|דמי/i, 1, 'total'],
      [/\bUSD\b|\bEUR\b|\bILS\b|\bNIS\b|\bGBP\b|\bJPY\b|\bCHF\b|\bTHB\b|\bTRY\b|\bAED\b|\bCAD\b|\bAUD\b|\bש"ח\b|ש״ח|₪|€|\$|£|¥|שקלים|דולר|אירו|יורו|לירות|\bcurrency\b|מטבע/i, 1, 'currency'],
      [/\bVisa\b (?:card|ending|debit|credit|\*+|xxxx|\d{4})|Mastercard|Master Card|\bAmex\b|American Express|Isracard|ישראכרט|\bDiners\b|Discover Card|Leumi Card|כאל\b|\bCAL\b|\bMax\b (?:card|כרטיס)|כרטיס מקס|PayPal|Payoneer|\bBit\b|ביט\b|PayBox|פייבוקס|Apple Pay|Google Pay|Revolut|\bWise\b|TransferWise|\bN26\b|\bMonzo\b|\bStripe\b|\bKlarna\b/i, 2, 'card/wallet'],
      [/bank transfer|העברה בנקאית|\bIBAN\b|\bSWIFT\b|\bBIC\b|wire transfer|\bsort code\b|\baccount number\b|מספר חשבון|\bbank statement\b|דף חשבון|exchange rate|שער חליפין|שער המרה|currency exchange|המרת מט"ח|מט"ח|מט״ח|bureau de change|\bATM\b|כספומט|\bwithdrawal\b|משיכה|\bcash advance|\bforex\b|\bchange ?money|החלפת כסף|\bBank Hapoalim|בנק הפועלים|\bBank Leumi|בנק לאומי|\bDiscount Bank|בנק דיסקונט|\bMizrahi|מזרחי טפחות|Bank of Jerusalem|בנק ירושלים|\bOne Zero|וואן זירו|\bPepper\b|פפר/i, 3, 'bank/exchange'],
      [/\bshop\b|\bstore\b|חנות|\bsupermarket\b|סופרמרקט|\bmarket\b|\brestaurant\b|מסעדה|מסעדת|\bcaf[eé]\b|קפה|בית קפה|\bbistro\b|\bpizzeria\b|\btrattoria\b|\btaverna\b|\bbar\b|\bpub\b|\bmenu\b|תפריט|\bpharmacy receipt|\bgas station|\bpetrol\b|תחנת דלק|\bsouvenir|מזכרת|\bmuseum ticket|\bentrance fee|דמי כניסה|\badmission\b|\btour\b|סיור|\bexcursion\b|\bactivity\b|\bGetYourGuide|\bViator\b|\bTiqets\b|\bKlook\b|\bCivitatis\b|\bHeadout\b/i, 1, 'shop/tour'],
    ],
  };

  const folderOf = (key) => FOLDERS.find((f) => f.key === key) || FOLDERS[FOLDERS.length - 1];

  // a file name reads like prose once its separators are spaces; an OCR'd page
  // reads better with its whitespace collapsed and Hebrew punctuation normalized
  function normalize(name, text) {
    const n = String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_\-.+()[\]]+/g, ' ');
    const t = String(text || '').replace(/[״]/g, '"').replace(/[׳’‘]/g, "'").replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n');
    return `${n}\n${t}`.slice(0, 60000);
  }

  function withGlobal(re) {
    return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  }

  function scoreAll(text) {
    const scores = {};
    for (const folder of Object.keys(RULES)) {
      let score = 0;
      const hits = [];
      for (const [re, w, label] of RULES[folder]) {
        const first = re.exec(text);
        if (!first) continue;
        // count distinct matches of this one clue — capped, so a receipt listing
        // twenty prices doesn't drown a stronger folder
        const g = withGlobal(re);
        const seen = new Set();
        let m;
        while ((m = g.exec(text)) && seen.size < 3) {
          seen.add(m[0].trim().toLowerCase());
          if (m[0] === '') g.lastIndex++;
        }
        score += seen.size >= 2 ? w * 1.5 : w;
        hits.push({ w, label: (label || first[0]).trim().replace(/\s+/g, ' ').slice(0, 24), match: first[0].trim().slice(0, 24) });
      }
      hits.sort((a, b) => b.w - a.w);
      scores[folder] = { score: Math.round(score * 10) / 10, hits };
    }
    return scores;
  }

  // { folder, tags, score, via, scores } — `via` says what decided it: 'content' when the
  // document's text was needed to reach the answer, 'name' when the file name alone
  // would have given the same folder, 'none' when nothing matched at all.
  function pick(scores) {
    let best = 'other';
    let bestScore = 0;
    for (const f of FOLDERS) {
      const s = scores[f.key]?.score || 0;
      if (s > bestScore) { best = f.key; bestScore = s; }
    }
    return { best, bestScore, maxW: best === 'other' ? 0 : scores[best].hits[0].w };
  }

  function classify({ name = '', text = '' } = {}) {
    let scores = scoreAll(normalize(name, text));
    let { best, bestScore, maxW } = pick(scores);
    let via = 'content';
    // a page of prose that happens to mention the flight and a suitcase is not a
    // ticket: with text in hand, one strong clue (or a pile of typical ones) is the
    // bar. A bare file name gets the benefit of the doubt, as it always did — the
    // name is all the user chose to tell us, and "ticket.pdf" means what it says.
    if (text && best !== 'other' && maxW < 3 && bestScore < 6) {
      scores = scoreAll(normalize(name, ''));
      ({ best, bestScore, maxW } = pick(scores));
      via = 'name';
    }
    if (best === 'other') return { folder: 'other', tags: [], score: 0, via: 'none', scores };
    const tags = [];
    for (const h of scores[best].hits) {
      // the reason shown is the matched text for specific clues (an airport code,
      // an insurer's name) and the clue's label for generic ones
      const t = /^[A-Z0-9]{2,7}$/.test(h.match) || h.w >= 3 ? h.match : h.label;
      if (!tags.includes(t)) tags.push(t);
      if (tags.length === 3) break;
    }
    if (!text) via = 'name';
    else if (via === 'content') {
      const byName = pick(scoreAll(normalize(name, '')));
      if (byName.best === best && byName.bestScore >= bestScore) via = 'name';
    }
    return { folder: best, tags, score: bestScore, via, scores };
  }

  return { FOLDERS, folderOf, classify, RULES };
});
