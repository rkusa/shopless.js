import Decimal from 'decimal.js-light'

const LOCAL_STORAGE_KEY = 'shoplessCart'
const ZERO = new Decimal(0)

interface CartOpts {
  endpoint: string
  currency?: string
  stackLineItems?: boolean
}

interface CartValue {
  currency: string
  lineItems: LineItemValue[]
  invoiceAddress: AddressValue | null
  shippingAddress: AddressValue | null
  email: string | null
}

export interface Taxrate {
  taxrate: number
  countries: string[]
  productType?: string
}

export interface ShippingMethod {
  price: number
  currency: string
  name: string
  countries: string[]
}

export interface Settings {
  allowedCountries: { [k: string]: string }
  taxrates: Taxrate[]
  shipping: ShippingMethod[]
}

export interface Payment<Meta> {
  method: string
  id: string
  meta: Meta | null
}

interface OrderOpts<Meta> {
  payment: Payment<Meta>
}

export class Cart {
  readonly endpoint: string
  readonly currency: string
  private readonly stackLineItems: boolean
  private readonly cache: Map<string, JsonLd | null>
  settings: Settings | null
  lineItems: LineItem[]
  email?: string | null
  invoiceAddress?: Address | null
  shippingAddress?: Address | null
  shippingRules?: ShippingMethod[]

  constructor(opts: CartOpts) {
    if (!opts || !opts.endpoint) {
      throw new TypeError('Endpoint must be defined')
    }

    this.endpoint = opts.endpoint
    if (this.endpoint[this.endpoint.length - 1] !== '/') {
      this.endpoint += '/'
    }
    this.currency = opts.currency || 'EUR'
    this.stackLineItems = opts.stackLineItems === false ? false : true
    this.cache = new Map()
    this.settings = null

    this.lineItems = []
  }

  valueOf(): CartValue {
    return {
      currency: this.currency.valueOf(),
      lineItems: this.lineItems.valueOf() as LineItemValue[],
      invoiceAddress: this.invoiceAddress ? (this.invoiceAddress.valueOf() as AddressValue) : null,
      shippingAddress: this.shippingAddress
        ? (this.shippingAddress.valueOf() as AddressValue)
        : null,
      email: this.email ? this.email.valueOf() : null,
    }
  }

  async restore() {
    const json = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    if (json) {
      const data: CartValue = JSON.parse(json)
      if (data.currency !== this.currency) {
        // @ts-ignore setting a readonly property
        this.currency = data.currency
      }

      this.settings = await fetchSettings()
      this.lineItems = data.lineItems.map(data => {
        return data instanceof LineItem ? data : new LineItem(data)
      })
      this.invoiceAddress = data && data.invoiceAddress && new Address(data.invoiceAddress)
      this.shippingAddress = data && data.shippingAddress && new Address(data.shippingAddress)
      this.email = data.email
      this.updateShipping()
    } else {
      return
    }
  }

  async add(url: string, qty: number, meta: any, options: { [k: string]: number | boolean }) {
    if (!qty) {
      return
    }

    if (!this.settings) {
      this.settings = await fetchSettings()
    }

    const data = await this.fetchProductData(url)
    if (!data) {
      throw new Error("Add to cart failed - product data couldn't be extracted from: " + url)
    }

    let offer: JsonLdOffer | null = null
    if (data.offers) {
      if (Array.isArray(data.offers)) {
        offer = data.offers.filter(o => o.priceCurrency === this.currency)[0]
      } else if (data.offers.priceCurrency === this.currency) {
        offer = data.offers
      }
    }

    if (!offer) {
      throw new Error('Product data does not contain an offer (price), product data is: ' + data)
    }

    let taxrates = []
    if (data.additionalType) {
      for (const setting of this.settings!.taxrates) {
        if (data.additionalType === setting.productType) {
          taxrates.push(setting)
        }
      }
    }

    if (taxrates.length === 0) {
      for (const setting of this.settings!.taxrates) {
        if (!setting.productType) {
          taxrates.push(setting)
        }
      }
    }

    const lineOptions =
      options &&
      Object.entries(options)
        .map(([sku, value]) => {
          const option = data.options.find(o => o.sku === sku)
          if (!option) {
            throw new Error(`Option with sku ${sku} does not exist`)
          }

          // check incompatible constraints
          for (const c of option.constraints) {
            if (c.kind === 'incompatible' && c.option in options) {
              throw new Error(`Incompatible options ${sku} and ${c.option}`)
            }
          }

          const constraint = option.constraints.find(c => {
            switch (c.kind) {
              case 'number':
                return (
                  offer!.priceCurrency === c.currency &&
                  (value === undefined ||
                    value === c.value ||
                    ((c.min === undefined || value >= c.min) &&
                      (c.max === undefined || value <= c.max) &&
                      (c.step === undefined || (value as number) % c.step === 0)))
                )
              case 'boolean':
                return offer!.priceCurrency === c.currency && (!c.value || value === c.value)
              default:
                return false
            }
          }) as NumberConstraint | BooleanConstraint | undefined

          if (!constraint) {
            throw new Error(`Unsupported value ${value} for option ${sku}`)
          }

          // check for price adjustments
          let price = constraint.price
          for (const c of option.constraints) {
            if (
              c.kind === 'adjustment' &&
              c.currency === offer!.priceCurrency &&
              c.option in options &&
              options[c.option] !== false &&
              value !== false
            ) {
              price += c.price
            }
          }

          return {
            sku,
            value,
            price: new Decimal(price),
            name: option.name,
          }
        })
        .filter(o => o)

    const lineItem = new LineItem({
      url: url,
      quantity: new Decimal(qty),
      price: offer.price,
      taxrates: taxrates,
      name: data.name,
      meta: meta,
      options: lineOptions,
    })

    let isNew = true

    if (this.stackLineItems) {
      for (const lhs of this.lineItems) {
        if (lhs.equals(lineItem)) {
          lhs.quantity = lhs.quantity.add(lineItem.quantity)
          isNew = false
          break
        }
      }
    }

    if (isNew) {
      this.lineItems.push(lineItem)
    }

    saveCart(this)
    this.updateShipping()
  }

  remove(lineItem: LineItem) {
    const ix = this.lineItems.indexOf(lineItem)
    if (ix > -1) {
      this.lineItems.splice(ix, 1)
      saveCart(this)
    }
    this.updateShipping()
  }

  async order<Meta>(opts: OrderOpts<Meta>) {
    if (!this.shippingAddress) {
      throw new Error('Must set a shipping address before creating an order')
    }

    const shippingMethod = this.shippingMethod(this.shippingAddress.country)
    const res = await fetch(this.endpoint + 'orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentMethod: opts.payment.method,
        paymentId: opts.payment.id,
        paymentMeta: opts.payment.meta,
        currency: this.currency,
        lineItems: this.lineItems.map(item => {
          let url = item.url
          if (url.substr(0, 4) !== 'http') {
            url = window.location.origin + url
          }
          return {
            url: url,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            total: item.total,
            options: item.options,
          }
        }),
        email: this.email,
        shippingAddress: this.shippingAddress,
        invoiceAddress: this.invoiceAddress,
        shippingMethod: shippingMethod ? shippingMethod.name : null,
        shipping: this.shipping,
        tax: this.tax,
        total: this.total,
      }),
    })
    if (res.status !== 201) {
      throw new Error(await res.text())
    }
  }

  reset() {
    this.lineItems = []
    this.invoiceAddress = this.shippingAddress = this.email = null
    saveCart(this)
  }

  updateShipping() {
    if (!this.settings) {
      return
    }

    this.shippingRules = this.settings.shipping.filter(rule => {
      // TODO: other rules
      return rule.currency === this.currency
    })
  }

  setInvoiceAddress(data: AddressValue) {
    this.invoiceAddress = data ? new Address(data) : null
    if (this.invoiceAddress) {
      this.invoiceAddress.countryName = this.countries()[this.invoiceAddress.country]
    }
    saveCart(this)
  }

  setShippingAddress(data: AddressValue) {
    this.shippingAddress = data ? new Address(data) : null
    if (this.shippingAddress) {
      this.shippingAddress.countryName = this.countries()[this.shippingAddress.country]
    }
    saveCart(this)
  }

  setEmail(email: string) {
    this.email = email
    saveCart(this)
  }

  async countryProvinces(country: string) {
    const res = await fetch(`/.well-known/shopless/provinces/${country.toLowerCase()}.json`)
    if (res.status !== 200) {
      return []
    } else {
      return await res.json()
    }
  }

  countries() {
    if (!this.settings) {
      return {}
    } else {
      return this.settings.allowedCountries
    }
  }

  shippingMethod(country: string) {
    if (!this.settings) {
      throw new Error('Settings not loaded')
    }

    return this.settings.shipping.filter(rule => {
      // TODO: other rules
      return rule.currency === this.currency && rule.countries.indexOf(country) > -1
    })[0]
  }

  get shipping() {
    if (!this.shippingAddress || !this.shippingRules) {
      return new Decimal(0)
    }

    const rule = this.shippingMethod(this.shippingAddress.country)
    if (rule) {
      return new Decimal(rule.price)
    } else {
      return new Decimal(0)
    }
  }

  get tax() {
    if (!this.shippingAddress) {
      return ZERO
    }

    const subtotal = this.subtotal
    if (subtotal.eq(0)) {
      return ZERO
    }

    let parts = new Map()
    let tax: Decimal = this.lineItems
      .map(lineItem => {
        if (!this.shippingAddress) {
          return new Decimal(0)
        }

        const taxrate = lineItem.countryTax(this.shippingAddress.country)
        let part = parts.get(taxrate.rate) || new Decimal(0)
        part = part.add(lineItem.total)
        parts.set(taxrate.rate, part)
        return taxrate.tax
      })
      .reduce((lhs, rhs) => lhs.add(rhs), new Decimal(0))

    const shipping = this.shipping
    if (shipping.gt(0)) {
      for (var [rate, part] of parts) {
        tax = tax.add(calcTax(part.div(subtotal).mul(shipping), rate))
      }
    }

    return tax.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  }

  get subtotal() {
    return this.lineItems
      .map(lineItem => lineItem.total)
      .reduce((lhs, rhs) => lhs.add(rhs), new Decimal(0))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  }

  get total() {
    return this.subtotal.add(this.shipping)
  }

  private async fetchProductData(url: string) {
    if (this.cache.has(url)) {
      return this.cache.get(url)
    }

    const data = await fetchJSONLD(url)
    this.cache.set(url, data)

    return data
  }
}

function saveCart(cart: Cart) {
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cart.valueOf()))
}

interface AddressValue {
  readonly recipient: string
  readonly line1: string
  readonly line2: string
  readonly postalCode: string
  readonly city: string
  readonly province?: string
  readonly country: string
  readonly countryName: string
}

export class Address implements AddressValue {
  public recipient: string
  public line1: string
  public line2: string
  public postalCode: string
  public city: string
  public province?: string
  public country: string
  public countryName: string

  constructor(data: AddressValue) {
    this.recipient = data.recipient
    this.line1 = data.line1
    this.line2 = data.line2 || ''
    this.postalCode = data.postalCode
    this.city = data.city
    this.province = data.province
    this.country = data.country
    this.countryName = data.countryName
  }
}

interface OptionValue {
  sku: string
  name: string
  price: string | Decimal
  value: number | boolean
}

interface Option {
  sku: string
  name: string
  price: Decimal
  value: number | boolean
}

interface LineItemValue {
  url: string
  quantity: string | Decimal
  price: string | Decimal | number
  taxrates: Taxrate[]
  name: string
  meta: any
  options: OptionValue[]
}

export class LineItem {
  public url: string
  public quantity: Decimal
  public price: Decimal
  public taxrates: Taxrate[]
  public name: string
  public meta: any
  public options: Option[]

  constructor(data: LineItemValue) {
    this.url = data.url
    this.quantity = new Decimal(data.quantity)
    this.price = new Decimal(data.price)
    if (!this.price.gt(0)) {
      throw new TypeError('Price cannot be negative (use a negative quantity instead)')
    }
    this.taxrates = data.taxrates
    this.name = data.name
    this.meta = data.meta
    this.options = data.options.map(o => ({
      ...o,
      price: new Decimal(o.price),
    }))
  }

  countryTax(isoCode: string) {
    for (const entry of this.taxrates) {
      if (entry.countries.indexOf(isoCode) !== -1) {
        let taxrate = new Decimal(entry.taxrate)
        if (taxrate.gt(0)) {
          return {
            tax: calcTax(this.total, taxrate),
            rate: taxrate,
          }
        }

        break
      }
    }

    return { tax: new Decimal(0), rate: new Decimal(0) }
  }

  get total() {
    let total = this.options.map(o => o.price).reduce((lhs, rhs) => lhs.add(rhs), this.price)
    total = this.quantity.mul(total)
    return total.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  }

  valueOf(): LineItemValue {
    return {
      url: this.url.valueOf(),
      quantity: this.quantity.valueOf(),
      price: this.price.valueOf(),
      taxrates: this.taxrates.valueOf() as Taxrate[],
      name: this.name.valueOf(),
      meta: this.meta.valueOf(),
      options: this.options.valueOf() as OptionValue[],
    }
  }

  equals(data: LineItemValue) {
    let rhs = new LineItem(data)
    // NOTICE: meta is not compared, experience should show whether it should be
    // compared as well
    return (
      this.url === rhs.url &&
      this.price.eq(rhs.price) &&
      this.name === rhs.name &&
      JSON.stringify(this.options) === JSON.stringify(rhs.options)
    )
  }
}

function calcTax(brutto: Decimal, taxrate: Decimal) {
  if (taxrate && taxrate.gt(0)) {
    taxrate = taxrate.div(100)
    const taxPart = taxrate.div(taxrate.add(1))

    return brutto.mul(taxPart)
  } else {
    return new Decimal(0)
  }
}

export interface JsonLd {
  '@context': 'http://schema.org'
  '@type': 'Product'
  image: string
  url: string
  name: string
  sku: string
  offers: JsonLdOffer | JsonLdOffer[]
  options: JsonLdOption[]
  additionalType?: string
}

export interface JsonLdOffer {
  '@type': 'Offer'
  priceCurrency: string
  price: number
  itemCondition: 'http://schema.org/NewCondition'
  availability: 'http://schema.org/InStock'
  additionalType?: string
}

export interface JsonLdOption {
  '@type': 'Option'
  sku: string
  name: string
  constraints: Constraint[]
}

export interface NumberConstraint {
  '@type': 'Constraint'
  kind: 'number'
  value?: number
  min?: number
  max?: number
  step?: number
  price: number
  currency: string
}

export interface BooleanConstraint {
  '@type': 'Constraint'
  kind: 'boolean'
  value: boolean
  price: number
  currency: string
}

export interface IncompatibleConstraint {
  '@type': 'Constraint'
  kind: 'incompatible'
  option: string
}

export interface AdjustmentConstraint {
  '@type': 'Constraint'
  kind: 'adjustment'
  option: string
  price: number
  currency: string
}

export type Constraint =
  | NumberConstraint
  | BooleanConstraint
  | IncompatibleConstraint
  | AdjustmentConstraint

async function fetchJSONLD(url: string): Promise<JsonLd | null> {
  let doc
  if (window.location.pathname === url) {
    doc = document.body
  } else {
    const res = await fetch(url, {
      headers: { Accept: 'text/html, application/ld+json' },
    })

    if (res.status !== 200) {
      throw new Error('Failed to retrieve product with URL: ' + url)
    }

    const contentType = res.headers.get('content-type')
    if (contentType && contentType.includes('text/html')) {
      doc = document.createElement('div')
      doc.innerHTML = await res.text()
    } else if (contentType && contentType.includes('application/ld+json')) {
      return await res.json()
    }
  }

  if (doc) {
    const els = doc.querySelectorAll("script[type='application/ld+json']")
    for (let i = 0, len = els.length; i < len; ++i) {
      const el = els[i] as HTMLScriptElement
      let json
      try {
        json = JSON.parse(el.innerText)
      } catch (err) {
        console.warn('Invalid JSON-LD has been ignored, error was: ' + err)
      }
      if (json['@context'] === 'http://schema.org' && json['@type'] === 'Product') {
        return json
      } else {
        console.warn(`JSON-LD with invalid @context/@type has been ignored: \
          ${json['@context']}/${json['@type']}`)
      }
    }
  }

  return null
}

async function fetchSettings() {
  const res = await fetch('/.well-known/shopless/settings.json', {
    headers: { Accept: 'application/json' },
  })

  if (res.status !== 200) {
    throw new Error('Failed to retrieve shopless settings with status: ' + res.status)
  }

  const contentType = res.headers.get('content-type')
  if (!contentType || !contentType.includes('application/json')) {
    throw new Error(
      'Failed to retrieve shopless settings, expected JSON, received content-type: ' + contentType
    )
  }

  return await res.json()
}
