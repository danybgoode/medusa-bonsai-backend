import {
  carMake, carModel, carYear, carKm, carTransmission, carFuel,
  canonicalBrandKey,
  matchesBrand, matchesModel, matchesYearFrom, matchesYearTo, matchesKmFrom, matchesKmTo,
  toCarFacetPoolEntry,
} from '../car-listing'

/**
 * cars-vertical · S1.1 — the two-namespace reconciliation.
 * A real seller car keeps its specs in `attrs.*` (make/model/year/km/fuel_type/
 * transmission); a seeded car keeps the legacy top-level `metadata.*` keys
 * (brand/year/km/fuel). Every accessor must read attrs first, fall back to the
 * top-level key, and tolerate missing/messy values. Pure — no DB.
 */
describe('car-listing accessors · attrs-first with legacy fallback', () => {
  const sellerCar = { attrs: { make: 'Volkswagen', model: 'Jetta', year: 2019, km: 48000, transmission: 'automatico', fuel_type: 'gasolina' } }
  const seedCar = { metadata: { brand: 'Nissan', year: '2020', km: '35000', transmission: 'manual', fuel: 'diesel' } }

  it('reads a seller car from attrs', () => {
    expect(carMake(sellerCar)).toBe('Volkswagen')
    expect(carModel(sellerCar)).toBe('Jetta')
    expect(carYear(sellerCar)).toBe(2019)
    expect(carKm(sellerCar)).toBe(48000)
    expect(carTransmission(sellerCar)).toBe('automatico')
    expect(carFuel(sellerCar)).toBe('gasolina')
  })

  it('falls back to the legacy top-level keys for a seeded car', () => {
    expect(carMake(seedCar)).toBe('Nissan')
    expect(carYear(seedCar)).toBe(2020)   // string coerced
    expect(carKm(seedCar)).toBe(35000)
    expect(carTransmission(seedCar)).toBe('manual')
    expect(carFuel(seedCar)).toBe('diesel')   // legacy key is `fuel`, not `fuel_type`
    expect(carModel(seedCar)).toBe('')        // no legacy equivalent
  })

  it('prefers attrs over the top-level key when both exist', () => {
    const both = { attrs: { make: 'Toyota' }, metadata: { brand: 'Honda', attrs: { make: 'Toyota' } } }
    expect(carMake(both)).toBe('Toyota')
  })

  it('reads attrs out of metadata.attrs when no top-level attrs field is present', () => {
    const l = { metadata: { attrs: { make: 'Mazda', year: 2021 } } }
    expect(carMake(l)).toBe('Mazda')
    expect(carYear(l)).toBe(2021)
  })

  it('tolerates missing / blank / non-numeric specs', () => {
    expect(carMake({})).toBe('')
    expect(carMake({ attrs: { make: '  ' } })).toBe('')
    expect(carYear({ attrs: { year: 'nomás' } })).toBeNull()
    expect(carKm({ attrs: {} })).toBeNull()
    expect(carYear({ metadata: null, attrs: null })).toBeNull()
  })

  it('strips grouping/units from a messy numeric string ("48 000 km")', () => {
    expect(carKm({ attrs: { km: '48 000' } })).toBe(48000)
    expect(carKm({ attrs: { km: '48,000 km' } })).toBe(48000)
  })
})

describe('car-listing filter predicates · honest missing-value handling', () => {
  const car = { attrs: { make: 'Volkswagen', model: 'Jetta', year: 2019, km: 48000 } }
  const noYear = { attrs: { make: 'Volkswagen' } }

  it('brand/model substring match, case-insensitive', () => {
    expect(matchesBrand(car, 'volkswagen')).toBe(true)
    expect(matchesBrand(car, 'nissan')).toBe(false)
    expect(matchesModel(car, 'jet')).toBe(true)
  })

  it('brand match is alias/casing aware so a facet count stays honest', () => {
    const vw = { attrs: { make: 'VW' } }
    const messy = { attrs: { make: '  volkswagén ' } }
    // A "Volkswagen" facet click must catch both the abbreviation and accented casing.
    expect(matchesBrand(vw, 'Volkswagen')).toBe(true)
    expect(matchesBrand(messy, 'Volkswagen')).toBe(true)
    expect(matchesBrand(car, 'volk')).toBe(true)   // partial free-text still works
  })

  it('canonicalBrandKey merges abbreviations + casing/accents', () => {
    expect(canonicalBrandKey('VW')).toBe('volkswagen')
    expect(canonicalBrandKey('Volkswagen')).toBe('volkswagen')
    expect(canonicalBrandKey('Chevy')).toBe('chevrolet')
    expect(canonicalBrandKey('Mercedes Benz')).toBe('mercedes-benz')
    expect(canonicalBrandKey('Citroën')).toBe('citroen')  // unknown → own normalized form
    expect(canonicalBrandKey('  ')).toBe('')
  })

  it('year/km bounds include a matching car', () => {
    expect(matchesYearFrom(car, 2018)).toBe(true)
    expect(matchesYearTo(car, 2022)).toBe(true)
    expect(matchesYearFrom(car, 2020)).toBe(false)
    expect(matchesKmTo(car, 60000)).toBe(true)
    expect(matchesKmFrom(car, 60000)).toBe(false)
  })

  it('EXCLUDES a car with an unknown year/km from a bounded search (cannot confirm a match)', () => {
    expect(matchesYearFrom(noYear, 2015)).toBe(false)
    expect(matchesYearTo(noYear, 2025)).toBe(false)
    expect(matchesKmTo(noYear, 100000)).toBe(false)
  })
})

describe('toCarFacetPoolEntry · compact projection for the facet rail', () => {
  it('projects the reconciled facet fields + price', () => {
    const entry = toCarFacetPoolEntry({ attrs: { make: 'Kia', model: 'Rio', year: 2022, km: 12000 }, price_cents: 28000000 })
    expect(entry).toEqual({ make: 'Kia', model: 'Rio', year: 2022, km: 12000, price_cents: 28000000 })
  })

  it('emits empty/null for a car with no specs (deriver tolerates it)', () => {
    expect(toCarFacetPoolEntry({})).toEqual({ make: '', model: '', year: null, km: null, price_cents: null })
  })
})
