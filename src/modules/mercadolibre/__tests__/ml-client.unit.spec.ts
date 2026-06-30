import { toMlImportItem } from '../client'

/**
 * Mercado Libre module · Sprint 2 import — the pure item narrower. No DB, no
 * network. Proves the raw ML item envelope collapses to the sanitised wire shape
 * (secure_url preferred, attributes narrowed, missing fields degrade to null/[]).
 */
describe('toMlImportItem', () => {
  it('narrows a full ML item, preferring secure_url and carrying the link flag', () => {
    const out = toMlImportItem(
      {
        id: 'MLM123',
        title: 'Taladro inalámbrico',
        category_id: 'MLM1234',
        price: 1850,
        currency_id: 'MXN',
        available_quantity: 4,
        condition: 'new',
        permalink: 'https://articulo.mercadolibre.com.mx/MLM-123',
        status: 'active',
        pictures: [
          { url: 'http://img/1.jpg', secure_url: 'https://img/1.jpg' },
          { url: 'http://img/2.jpg' },
        ],
        attributes: [{ id: 'BRAND', name: 'Marca', value_name: 'DeWalt' }],
      },
      'Descripción larga',
      true,
    )
    expect(out.pictures).toEqual([{ url: 'https://img/1.jpg' }, { url: 'http://img/2.jpg' }])
    expect(out.attributes).toEqual([{ id: 'BRAND', name: 'Marca', value_name: 'DeWalt' }])
    expect(out.description).toBe('Descripción larga')
    expect(out.already_linked).toBe(true)
    expect(out.price).toBe(1850)
  })

  it('degrades missing/odd fields to null/[] without throwing', () => {
    const out = toMlImportItem({ id: 'MLM9' }, '', false)
    expect(out).toMatchObject({
      id: 'MLM9',
      title: '',
      category_id: null,
      price: null,
      currency_id: null,
      available_quantity: null,
      condition: null,
      permalink: null,
      description: '',
      pictures: [],
      attributes: [],
      already_linked: false,
    })
  })
})
