// 极简 SMTP 客户端（tls/net，无外部依赖），支持 STARTTLS + AUTH LOGIN
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

export interface SmtpConfig {
  host: string
  port?: number
  secure?: boolean // true = 直接 SSL(465)；false = 25/587 用 STARTTLS
  user?: string
  pass?: string
  from?: string
}

type Socket = import('node:net').Socket
type TlsSocket = import('node:tls').TLSSocket

interface Resolver {
  (code: number, msg: string): void
}

export function createSmtpSender(cfg: SmtpConfig) {
  if (!cfg.host) return undefined
  const from = cfg.from || cfg.user || 'no-reply@ikit'
  const port = cfg.port ?? (cfg.secure ? 465 : 587)

  return async function send(to: string, subject: string, html: string) {
    await sendEmail(cfg, port, from, to, subject, html)
  }
}

function sendEmail(cfg: SmtpConfig, port: number, from: string, to: string, subject: string, html: string) {
  return new Promise<void>((resolve, reject) => {
    let raw = cfg.secure ? tlsConnect({ host: cfg.host, port, servername: cfg.host }) : netConnect(port, cfg.host)
    let stage = 'greeting'
    const lines: string[] = []
    let buf = ''
    let greeted = false

    const abort = (err: Error) => {
      raw.destroy()
      reject(err)
    }

    const read = (chunk: Buffer) => {
      buf += chunk.toString('utf-8')
      let idx
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        lines.push(line)
        const code = parseInt(line.slice(0, 3), 10)
        handle(code, line)
      }
    }

    const send = (s: string) => raw.write(s + '\r\n')

    const handle = (code: number, line: string) => {
      if (code >= 400) {
        abort(new Error(`SMTP error: ${line}`))
        return
      }
      step(code)
    }

    const expect = (codes: number[], next: () => void) => {
      pending = { codes, next }
    }
    let pending: { codes: number[]; next: () => void } | null = null
    const step = (code: number) => {
      if (!pending) return
      if (pending.codes.includes(code)) {
        const n = pending.next
        pending = null
        n()
      } else if (code >= 300 && code <= 399) {
        // 多行响应，忽略后续
      }
    }

    raw.on('data', read)
    raw.on('error', abort)
    raw.on('close', () => {
      if (stage !== 'done') abort(new Error('SMTP connection closed'))
    })

    raw.on('connect', () => {
      expect([220], () => {
        send(`EHLO i-kit`)
        expect([250], () => {
          if (cfg.secure) {
            authThenSend()
          } else {
            // STARTTLS
            send('STARTTLS')
            expect([220], () => {
              const tls = tlsConnect({ socket: raw as any, servername: cfg.host })
              tls.on('data', read)
              tls.on('error', abort)
              send(`EHLO i-kit`)
              expect([250], authThenSend)
            })
          }
        })
      })
    })

    function authThenSend() {
      if (!cfg.user || !cfg.pass) {
        sendMailCmd()
        return
      }
      send('AUTH LOGIN')
      expect([334], () => {
        send(Buffer.from(cfg.user!).toString('base64'))
        expect([334], () => {
          send(Buffer.from(cfg.pass!).toString('base64'))
          expect([235], sendMailCmd)
        })
      })
    }

    function sendMailCmd() {
      send(`MAIL FROM:<${from}>`)
      expect([250], () => {
        send(`RCPT TO:<${to}>`)
        expect([250], () => {
          send('DATA')
          expect([354], () => {
            const headers = [
              `From: <${from}>`,
              `To: <${to}>`,
              `Subject: ${subject}`,
              'MIME-Version: 1.0',
              'Content-Type: text/html; charset=utf-8',
              '',
              html,
            ].join('\r\n')
            send(headers)
            send('.')
            expect([250], () => {
              send('QUIT')
              stage = 'done'
              resolve()
            })
          })
        })
      })
    }
  })
}
