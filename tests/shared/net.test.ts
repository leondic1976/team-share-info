import { describe, it, expect } from 'vitest'
import { cidrOf, inCidr, ipAllowed, normalizeIp, toServerUrl } from '../../src/shared/net'
import { compareVersions } from '../../src/shared/semver'

describe('net helpers', () => {
  it('matches CIDR ranges', () => {
    expect(inCidr('192.168.10.5', '192.168.10.0/24')).toBe(true)
    expect(inCidr('192.168.11.5', '192.168.10.0/24')).toBe(false)
    expect(inCidr('10.1.2.3', '10.0.0.0/8')).toBe(true)
    expect(inCidr('::ffff:192.168.10.5', '192.168.10.0/24')).toBe(true)
    expect(inCidr('bad', '192.168.10.0/24')).toBe(false)
  })
  it('always allows loopback and treats empty lists as open', () => {
    expect(ipAllowed('127.0.0.1', ['10.0.0.0/8'])).toBe(true)
    expect(ipAllowed('::1', ['10.0.0.0/8'])).toBe(true)
    expect(ipAllowed('1.2.3.4', [])).toBe(true)
    expect(ipAllowed('1.2.3.4', ['10.0.0.0/8'])).toBe(false)
  })
  it('derives CIDR from netmask', () => {
    expect(cidrOf('192.168.10.37', '255.255.255.0')).toBe('192.168.10.0/24')
    expect(cidrOf('172.16.5.9', '255.255.0.0')).toBe('172.16.0.0/16')
  })
  it('normalizes server addresses', () => {
    expect(toServerUrl('192.168.0.5', 47800)).toBe('http://192.168.0.5:47800')
    expect(toServerUrl('192.168.0.5:5000', 47800)).toBe('http://192.168.0.5:5000')
    expect(toServerUrl('http://server-pc:47800/', 47800)).toBe('http://server-pc:47800')
    expect(toServerUrl('bad address!', 47800)).toBeNull()
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1')
  })
  it('compares versions', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })
})
