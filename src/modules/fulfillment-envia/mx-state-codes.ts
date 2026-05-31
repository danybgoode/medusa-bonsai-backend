/**
 * Envia.com 2-digit state code lookup for Mexican states.
 * All codes confirmed via geocodes.envia.com/zipcode/MX/{cp}.
 */

const NAME_TO_ENVIA: Record<string, string> = {
  'Aguascalientes':    'AG',
  'Baja California':   'BC',
  'Baja California Sur': 'BS',
  'Campeche':          'CM',
  'Chiapas':           'CS',
  'Chihuahua':         'CH',
  'Ciudad de México':  'CX',
  'Coahuila':          'CO',
  'Colima':            'CL',
  'Durango':           'DG',
  'Estado de México':  'EM',
  'Guanajuato':        'GT',
  'Guerrero':          'GR',
  'Hidalgo':           'HG',
  'Jalisco':           'JA',
  'Michoacán':         'MI',
  'Morelos':           'MO',
  'Nayarit':           'NA',
  'Nuevo León':        'NL',
  'Oaxaca':            'OA',
  'Puebla':            'PU',
  'Querétaro':         'QT',
  'Quintana Roo':      'QR',
  'San Luis Potosí':   'SL',
  'Sinaloa':           'SI',
  'Sonora':            'SO',
  'Tabasco':           'TB',
  'Tamaulipas':        'TM',
  'Tlaxcala':          'TL',
  'Veracruz':          'VE',
  'Yucatán':           'YU',
  'Zacatecas':         'ZA',
}

/**
 * Returns the Envia 2-digit state code for any state identifier.
 * Accepts display names, slugs, or codes already in correct format.
 * Falls back to the input unchanged.
 */
export function toEnviaStateCode(input: string): string {
  if (!input) return input
  const t = input.trim()

  if (NAME_TO_ENVIA[t]) return NAME_TO_ENVIA[t]

  // Case-insensitive name match
  const lower = t.toLowerCase()
  for (const [name, code] of Object.entries(NAME_TO_ENVIA)) {
    if (name.toLowerCase() === lower) return code
  }

  // Normalise accents + case for slug-style inputs
  const slug = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '-')
  const slugMap: Record<string, string> = {
    'aguascalientes': 'AG', 'baja-california': 'BC', 'baja-california-sur': 'BS',
    'campeche': 'CM', 'chiapas': 'CS', 'chihuahua': 'CH', 'ciudad-de-mexico': 'CX',
    'coahuila': 'CO', 'colima': 'CL', 'durango': 'DG', 'estado-de-mexico': 'EM',
    'guanajuato': 'GT', 'guerrero': 'GR', 'hidalgo': 'HG', 'jalisco': 'JA',
    'michoacan': 'MI', 'morelos': 'MO', 'nayarit': 'NA', 'nuevo-leon': 'NL',
    'oaxaca': 'OA', 'puebla': 'PU', 'queretaro': 'QT', 'quintana-roo': 'QR',
    'san-luis-potosi': 'SL', 'sinaloa': 'SI', 'sonora': 'SO', 'tabasco': 'TB',
    'tamaulipas': 'TM', 'tlaxcala': 'TL', 'veracruz': 'VE', 'yucatan': 'YU',
    'zacatecas': 'ZA',
  }
  if (slugMap[slug]) return slugMap[slug]

  // Already looks like a 2-4 char code
  if (/^[A-Z]{2,4}$/.test(t)) return t

  return t
}
