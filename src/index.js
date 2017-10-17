import Decimal from "decimal.js-light"

const LOCAL_STORAGE_KEY = "shoplessCart"

export default class Shopless {
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
    this._cart = null
    this.settings = null
  }

  get cart() {
    if (this._cart) {
      return this._cart
    }

    let cart = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    if (cart) {
      cart = new Cart(JSON.parse(cart))
    } else {
      cart = new Cart()
    }

    this._cart = cart
    return cart
  }

  async addToCart(url, qty, meta) {
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

    const lineItem = new LineItem({
      url: url,
      quantity: qty,
      price: offer.price,
      taxrates: taxrates,
      name: data.name,
      meta: meta,
    })

    const cart = this.cart
    let isNew = true

    if (this.stackLineItems) {
      for (const lhs of cart.lineItems) {
        if (lhs.equals(lineItem)) {
          lhs.quantity = lhs.quantity.add(lineItem.quantity)
          isNew = false
          break
        }
      }
    }

    if (isNew) {
      cart.lineItems.push(lineItem)
    }

    saveCart(cart)

    return cart
  }

  removeFromCart(lineItem) {
    const cart = this.cart
    const ix = cart.lineItems.indexOf(lineItem)
    if (ix > -1) {
      cart.lineItems.splice(ix, 1)
      saveCart(cart)
    }
  }

  async order() {
    const cart = this.cart
    const res = await fetch(this.endpoint + "orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentMethod: "paypal",
        currency: this.currency,
        lineItems: cart.lineItems.map(item => {
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
          }
        }),
        shippingAddress: cart.shippingAddress,
        invoiceAddress: cart.invoiceAddress,
        total: cart.total,
        tax: cart.tax,
      }),
    })
    // TODO: error handling
    const json = await res.json();
    return json
  }
}

function saveCart(cart) {
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cart))
}

class Address {
  constructor(data) {
    this.line1 = data.line1
    this.line2 = data.line2
    this.postalCode = data.postalCode
    this.city = data.city
    this.country = data.country
  }
}

class Cart {
  constructor(data) {
    this.lineItems = data ? data.lineItems.map(data => {
      return data instanceof LineItem ? data : new LineItem(data)
    }) : []
    this.invoiceAddress = data && data.invoiceAddress && new Address(data.invoiceAddress)
    this.shippingAddress = data && data.shippingAddress && new Address(data.shippingAddress)
  }

  setInvoiceAddress(data) {
    this.invoiceAddress = new Address(data)
    saveCart(this)
  }

  setShippingAddress(data) {
    this.shippingAddress = new Address(data)
    saveCart(this)
  }

  get tax() {
    if (!this.shippingAddress) {
      return 0
    }

    return this.lineItems
      .map(lineItem => lineItem.countryTax(this.shippingAddress.country))
      .reduce((lhs, rhs) => lhs.add(rhs), new Decimal(0))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  }

  get total() {
    return this.lineItems
      .map(lineItem => lineItem.total)
      .reduce((lhs, rhs) => lhs.add(rhs), new Decimal(0))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
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
  }

  countryTax(isoCode) {
    for (const entry of this.taxrates) {
      if (entry.countries.indexOf(isoCode) !== -1) {
        let taxrate = new Decimal(entry.taxrate)
        if (taxrate.gt(0)) {
          taxrate = taxrate.div(100)
          const taxPart = taxrate.div(taxrate.add(1))

          return this.total.mul(taxPart)
        }

        break
      }
    }

    return 0
  }

  get total() {
    const total = this.quantity.mul(this.price)
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
    }
  }

  equals(data) {
    let rhs = new LineItem(data)
    // NOTICE: meta is not compared, experience should show whether it should be
    // compared as well
    return this.url === rhs.url &&
           this.price.eq(rhs.price) &&
           this.name === rhs.name
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
    console.log(fragment)
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
