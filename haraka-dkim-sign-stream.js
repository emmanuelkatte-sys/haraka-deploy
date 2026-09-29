'use strict'

const crypto = require('node:crypto')
const { Stream } = require('node:stream')
const utils = require('haraka-utils')

class DKIMSignStream extends Stream {
  constructor(props, header, done) {
    super()

    this.selector = props.selector
    this.domain_name = props.domain
    this.private_key = props.private_key
    this.headers_to_sign = props.headers
    this.header = header
    this.end_callback = done
    this.writable = true
    this.found_eoh = false
    this.buffer = { ar: [], len: 0 }
    this.hash = crypto.createHash('SHA256')
    this.line_buffer = { ar: [], len: 0 }
    this.signer = crypto.createSign('RSA-SHA256')
    this.body_found = false
    // Always advertise and hash as relaxed/relaxed (plugin default is simple).
    this.body_canon = 'relaxed'
  }

  static canonicalize_body_relaxed(bufin) {
    const tmp = []
    const len = bufin.length
    let last_chunk_idx = 0
    let idx_wsp = 0
    let in_wsp = false

    for (let idx = 0; idx < len; idx++) {
      const char = bufin[idx]
      if (char === 9 || char === 32) {
        if (!in_wsp) {
          in_wsp = true
          idx_wsp = idx
        }
      } else if (char === 13 || char === 10) {
        if (in_wsp) {
          tmp.push(bufin.slice(last_chunk_idx, idx_wsp))
        } else {
          tmp.push(bufin.slice(last_chunk_idx, idx))
        }
        break
      } else if (in_wsp) {
        in_wsp = false
        tmp.push(bufin.slice(last_chunk_idx, idx_wsp))
        tmp.push(Buffer.from(' '))
        last_chunk_idx = idx
      }
    }

    tmp.push(Buffer.from([13, 10]))
    return Buffer.concat(tmp)
  }

  write(buf) {
    if (this.buffer.ar.length) {
      this.buffer.ar.push(buf)
      this.buffer.len += buf.length
      const nb = Buffer.concat(this.buffer.ar, this.buffer.len)
      buf = nb
      this.buffer = { ar: [], len: 0 }
    }
    let offset = 0
    while ((offset = utils.indexOfLF(buf)) !== -1) {
      let line = buf.slice(0, offset + 1)
      if (buf.length > offset) {
        buf = buf.slice(offset + 1)
      }

      if (this.body_canon === 'relaxed') {
        line = DKIMSignStream.canonicalize_body_relaxed(line)
      }

      if (line.length === 2 && line[0] === 0x0d && line[1] === 0x0a) {
        if (!this.found_eoh) {
          this.found_eoh = true
        } else {
          this.line_buffer.ar.push(line)
          this.line_buffer.len += line.length
        }
      } else {
        if (!this.found_eoh) continue
        this.#hashBodyLine(line)
      }
    }
    if (buf.length) {
      this.buffer.ar.push(buf)
      this.buffer.len += buf.length
    }
  }

  #hashBodyLine(line) {
    if (this.line_buffer.ar.length) {
      const lb = Buffer.concat(this.line_buffer.ar, this.line_buffer.len)
      this.line_buffer = { ar: [], len: 0 }
      this.hash.update(lb)
    }
    this.hash.update(line)
    this.body_found = true
  }

  #finalizeBodyHash() {
    if (this.buffer.ar.length) {
      let le = Buffer.concat(this.buffer.ar, this.buffer.len)
      if (le[le.length - 1] !== 0x0a) {
        le = Buffer.concat([le, Buffer.from('\r\n')])
      }
      if (this.body_canon === 'relaxed') {
        le = DKIMSignStream.canonicalize_body_relaxed(le)
      }
      this.hash.update(le)
      this.buffer = { ar: [], len: 0 }
    }

    if (!this.body_found) {
      this.hash.update(Buffer.from('\r\n'))
    }

    return this.hash.digest('base64')
  }

  #signHeaders() {
    const headerCase = {
      from: 'From',
      to: 'To',
      subject: 'Subject',
      date: 'Date',
      'message-id': 'Message-ID',
      'mime-version': 'MIME-Version',
      'content-type': 'Content-Type',
      'content-transfer-encoding': 'Content-Transfer-Encoding',
      'reply-to': 'Reply-To',
      cc: 'Cc',
      sender: 'Sender',
    }
    const headers = []
    for (const element of this.headers_to_sign) {
      const instances = this.header.get_all(element)
      for (let i = instances.length - 1; i >= 0; i--) {
        let head = instances[i]
        if (!head) continue
        head = head.replace(/\r?\n/gm, '')
        head = head.replace(/\s+/gm, ' ')
        head = head.replace(/\s+$/gm, '')
        this.signer.update(`${element.toLowerCase()}:${head}\r\n`)
        headers.push(headerCase[element.toLowerCase()] || element)
      }
    }
    return headers
  }

  #identityFrom() {
    const fromRaw = String(this.header.get('from') || '').replace(/\r?\n/g, ' ')
    const identMatch = fromRaw.match(/<([^>]+)>/) || fromRaw.match(/([^\s<>"]+@[^\s<>"]+)/)
    return identMatch ? identMatch[1].trim() : ''
  }

  #assembleHeader(bodyhash, headers) {
    const identity = this.#identityFrom()
    const identUnfolded = identity ? ` i=${identity};` : ''
    const identFolded = identity ? ` i=${identity};\r\n` : ''
    const h = headers.join(':')
    const canon = `relaxed/${this.body_canon}`
    const unfolded =
      `v=1; a=rsa-sha256; c=${canon}; s=${this.selector}; d=${this.domain_name}; h=${h};` +
      identUnfolded +
      ` bh=${bodyhash}; b=`
    this.signer.update('dkim-signature:' + unfolded)
    const signature = this.signer.sign(this.private_key, 'base64')
    let folded =
      `v=1; a=rsa-sha256; c=${canon}; s=${this.selector};\r\n` +
      ` d=${this.domain_name};\r\n` +
      ` h=${h};\r\n` +
      identFolded +
      ` bh=${bodyhash};\r\n` +
      ` b=`
    const chunk = 76
    for (let i = 0; i < signature.length; i += chunk) {
      if (i > 0) folded += '\r\n  '
      folded += signature.slice(i, i + chunk)
    }
    return folded
  }

  end(buf) {
    this.writable = false
    const bodyhash = this.#finalizeBodyHash()
    const headers = this.#signHeaders()
    const dkim_header = this.#assembleHeader(bodyhash, headers)
    if (this.end_callback) this.end_callback(null, dkim_header)
    this.end_callback = null
  }

  destroy() {
    this.writable = false
    if (this.end_callback) {
      this.end_callback(new Error('Stream destroyed'))
    }
  }
}

module.exports = DKIMSignStream
