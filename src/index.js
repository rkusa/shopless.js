import Decimal from "decimal.js-light"

const LOCAL_STORAGE_KEY = "shoplessCart"
const ZERO = new Decimal(0)

export class Cart {
  constructor(opts) {
    if (!opts || !opts.endpoint) {
      throw new TypeError("Endpoint must be defined")
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
    this.invoiceAddress = this.shippingAddress = null
  }

  valueOf() {
    return {
      currency: this.currency.valueOf(),
      lineItems: this.lineItems.valueOf(),
      invoiceAddress: this.invoiceAddress ? this.invoiceAddress.valueOf() : null,
      shippingAddress: this.shippingAddress ? this.shippingAddress.valueOf() : null,
    }
  }

  async restore() {
    let data = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    if (data) {
      data = JSON.parse(data)
      if (data.currency !== this.currency) {
        return
      }
    } else {
      return
    }

    this.settings = await fetchSettings()
    this.lineItems = data.lineItems.map(data => {
      return data instanceof LineItem ? data : new LineItem(data)
    })
    this.invoiceAddress = data && data.invoiceAddress && new Address(data.invoiceAddress)
    this.shippingAddress = data && data.shippingAddress && new Address(data.shippingAddress)
    this.updateShipping()
  }

  async add(url, qty, meta, options) {
    if (!qty) {
      return this.cart
    }

    if (!this.settings) {
      this.settings = await fetchSettings()
    }

    const data = await fetchProductData.call(this, url)
    if (data === null) {
      throw new Error("Add to cart failed - product data could't be extracted from: " + url)
    }

    let offer = null
    if (data.offers) {
      if (Array.isArray(data.offers)) {
        offer = data.offers.filter(o => o.priceCurrency === this.currency)[0]
      } else if (data.offers.priceCurrency === this.currency) {
        offer = data.offers
      }
    }

    if (!offer) {
      throw new Error("Product data does not contain an offer (price), product data is: " + data)
    }

    let taxrates = []
    if (data.additionalType) {
      for (const setting of this.settings.taxrates) {
        if (data.additionalType === setting.productType) {
          taxrates.push(setting)
        }
      }
    }

    if (taxrates.length === 0) {
      for (const setting of this.settings.taxrates) {
        if (!setting.productType) {
          taxrates.push(setting)
        }
      }
    }

    const lineOptions = options && Object.entries(options).map(([sku, value]) => {
      const option = data.options.find(o => o.sku === sku)
      if (!option) {
        throw new Error(`Option with sku ${sku} does not exist`)
      }

      const constraint = option.constraints.find(c => {
        switch (c.kind) {
        case "number":
          value = parseFloat(value, 10)
          return offer.priceCurrency === c.currency
            && ((value === undefined || value === c.value) || (
                (c.min === undefined || value >= c.min)
                && (c.max === undefined || value <= c.max)
                && (c.step === undefined || value % c.step === 0)
              ))
          break
        case "boolean":
          return offer.priceCurrency === c.currency
            && (!c.value || value === c.value)
          break
        default:
          return false
        }
      })

      if (!constraint) {
        throw new Error(`Unsupported value ${value} for option ${sku}`)
      }

      return { sku, kind: option.kind, value, price: new Decimal(constraint.price), name: option.name }
    }).filter(o => o)

    const lineItem = new LineItem({
      url: url,
      quantity: qty,
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

  remove(lineItem) {
    const ix = this.lineItems.indexOf(lineItem)
    if (ix > -1) {
      this.lineItems.splice(ix, 1)
      saveCart(this)
    }
    this.updateShipping()
  }

  async order(opts) {
    const res = await fetch(this.endpoint + "orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentMethod: opts.payment.method,
        paymentMeta: opts.payment.meta,
        currency: this.currency,
        lineItems: this.lineItems.map(item => {
          let url = item.url
          if (url.substr(0, 4) !== "http") {
            url = location.origin + url
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
        shippingAddress: this.shippingAddress,
        invoiceAddress: this.invoiceAddress,
        shipping: this.shipping,
        tax: this.tax,
        total: this.total,
      }),
    })
    // TODO: error handling
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

  setInvoiceAddress(data) {
    this.invoiceAddress = data ? new Address(data) : null
    saveCart(this)
  }

  setShippingAddress(data) {
    this.shippingAddress = data ? new Address(data) : null
    saveCart(this)
  }

  get shipping() {
    if (!this.shippingAddress) {
      return new Decimal(0)
    }

    const rules = this.shippingRules.filter(rule => {
      return rule.countries.indexOf(this.shippingAddress.country) > -1
    })

    if (rules.length > 0) {
      return new Decimal(rules[0].price)
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
    let tax = this.lineItems
      .map(lineItem => {
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
}

function saveCart(cart) {
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cart.valueOf()))
}

class Address {
  constructor(data) {
    this.recipient = data.recipient
    this.line1 = data.line1
    this.line2 = data.line2
    this.postalCode = data.postalCode
    this.city = data.city
    this.country = data.country
  }
}

class LineItem {
  constructor(data) {
    if (data instanceof LineItem) {
      return data
    }

    this.url = data.url
    this.quantity = new Decimal(data.quantity)
    this.price = new Decimal(data.price)
    if (!this.price.gt(0)) {
      throw new TypeError("Price cannot be negative (use a negative quantity instead)")
    }
    this.taxrates = data.taxrates
    this.name = data.name
    this.meta = data.meta
    this.options = data.options.map(o => {
      o.price = new Decimal(o.price)
      return o
    })
  }

  countryTax(isoCode) {
    for (const entry of this.taxrates) {
      if (entry.countries.indexOf(isoCode) !== -1) {
        let taxrate = new Decimal(entry.taxrate)
        if (taxrate.gt(0)) {
          return {
            tax: calcTax(this.total, taxrate),
            rate: taxrate
          }
        }

        break
      }
    }

    return  { tax: 0, rate: 0 }
  }

  get total() {
    let total = this.options.map(o => o.price).reduce(
      (lhs, rhs) => lhs.add(rhs),
      this.price
    )
    total = this.quantity.mul(total)
    return total.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  }

  valueOf() {
    return {
      url: this.url.valueOf(),
      quantity: this.quantity.valueOf(),
      price: this.price.valueOf(),
      taxrates: this.taxrates.valueOf(),
      name: this.name.valueOf(),
      meta: this.meta.valueOf(),
      options: this.options.valueOf(),
    }
  }

  equals(data) {
    let rhs = new LineItem(data)
    // NOTICE: meta is not compared, experience should show whether it should be
    // compared as well
    return this.url === rhs.url &&
           this.price.eq(rhs.price) &&
           this.name === rhs.name &&
           JSON.stringify(this.options) === JSON.stringify(rhs.options)
  }
}

function calcTax(brutto, taxrate) {
  if (taxrate.gt(0)) {
    taxrate = taxrate.div(100)
    const taxPart = taxrate.div(taxrate.add(1))

    return brutto.mul(taxPart)
  } else {
    return new Decimal(0)
  }
}

async function fetchProductData(url) {
  if (this.cache.has(url)) {
    return this.cache.get(url)
  }

  const data = await fetchJSONLD(url)
  this.cache.set(url, data)

  return data
}

async function fetchJSONLD(url) {
  const res = await fetch(url, {
    headers: { Accept: "text/html, application/ld+json" }
  })

  if (res.status !== 200) {
    throw new Error("Failed to retrieve product with URL: " + url)
  }

  const contentType = res.headers.get("content-type")
  if(contentType && contentType.includes("text/html")) {
    const fragment = document.createElement("div")
    fragment.innerHTML = await res.text()
    // console.log(fragment)
    const els = fragment.querySelectorAll("script[type='application/ld+json']")
    for (let i = 0, len = els.length; i < len; ++i) {
      const el = els[i]
      let json
      try {
        json = JSON.parse(el.innerText)
      } catch (err) {
        console.warn("Invalid JSON-LD has been ignored, error was: " + err)
      }
      if (json["@context"] === "http://schema.org" && json["@type"] === "Product") {
        return json
      } else {
        console.warn(`JSON-LD with invalid @context/@type has been ignored: \
          ${json["@context"]}/${json["@type"]}`)
      }
    }
  } else if (contentType && contentType.includes("application/ld+json")) {
    return await res.json()
  }

  return null
}

async function fetchSettings() {
  const res = await fetch("/.well-known/shopless/settings.json", {
    headers: { Accept: "application/json" }
  })

  if (res.status !== 200) {
    throw new Error("Failed to retrieve shopless settings with status: " + res.status)
  }

  const contentType = res.headers.get("content-type")
  if(!contentType || !contentType.includes("application/json")) {
    throw new Error("Failed to retreive shopless settings, expected JSON, received content-type: ", content-type)
  }

  return await res.json()
}
