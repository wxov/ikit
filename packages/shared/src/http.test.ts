import test from 'node:test'
import assert from 'node:assert/strict'
import { isBlockedAddress, safeFetchText, SafeFetchError } from './http.js'

test('isBlockedAddress：私网/本机/链路本地/保留段均拦截', () => {
  const blocked = [
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254', // 云元数据
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1', // 多播
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
  ]
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} 应被拦截`)
})

test('isBlockedAddress：公网地址放行', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} 应放行`)
  }
})

test('safeFetchText：仅允许 http/https', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)']) {
    await assert.rejects(() => safeFetchText(url), (e: unknown) => {
      assert.ok(e instanceof SafeFetchError)
      assert.equal(e.code, 'E_PROTOCOL')
      return true
    })
  }
})

test('safeFetchText：拒绝内网/本机/元数据地址', async () => {
  for (const url of ['http://127.0.0.1:3000/x', 'http://169.254.169.254/latest/meta-data/', 'http://10.1.1.1/', 'http://[::1]:8080/']) {
    await assert.rejects(() => safeFetchText(url), (e: unknown) => {
      assert.ok(e instanceof SafeFetchError)
      assert.equal(e.code, 'E_PRIVATE_ADDRESS')
      return true
    })
  }
})

test('safeFetchText：localhost 解析到本机同样被拒', async () => {
  await assert.rejects(() => safeFetchText('http://localhost:3000/'), (e: unknown) => {
    assert.ok(e instanceof SafeFetchError)
    assert.equal(e.code, 'E_PRIVATE_ADDRESS')
    return true
  })
})

test('safeFetchText：非法 URL 报 E_BAD_URL', async () => {
  await assert.rejects(() => safeFetchText('not a url'), (e: unknown) => {
    assert.ok(e instanceof SafeFetchError)
    assert.equal(e.code, 'E_BAD_URL')
    return true
  })
})
