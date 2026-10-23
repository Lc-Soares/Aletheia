import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canonicalAddress, isPublicAddress } from "./ip-policy.ts";

describe("isPublicAddress: IPv4 bloqueado", () => {
  for (const ip of [
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.0",
    "10.255.255.255",
    "100.64.0.0",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.0.0",
    "169.254.169.254",
    "169.254.255.255",
    "172.16.0.0",
    "172.31.255.255",
    "192.0.0.0",
    "192.0.0.255",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.0",
    "192.168.255.255",
    "198.18.0.0",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.0",
    "255.255.255.255",
  ]) {
    test(ip, () => assert.equal(isPublicAddress(ip), false));
  }
});

describe("isPublicAddress: IPv4 permitido (vizinhos das faixas)", () => {
  for (const ip of [
    "1.1.1.1",
    "8.8.8.8",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ]) {
    test(ip, () => assert.equal(isPublicAddress(ip), true));
  }
});

describe("isPublicAddress: IPv6 bloqueado", () => {
  for (const ip of [
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fdff:ffff::1",
    "fe80::1",
    "febf::1",
    "fec0::1",
    "ff00::1",
    "ff02::1",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "2002::1",
    "2002:7f00:1::1",
    "2001::1",
    "2001:0:4136:e378::1",
    "2001:db8::1",
    "3fff::1",
    "100::1",
    "::127.0.0.1",
    "::7f00:1",
    "4000::1",
    "fe80::1%eth0",
  ]) {
    test(ip, () => assert.equal(isPublicAddress(ip), false));
  }
});

describe("isPublicAddress: IPv6 permitido", () => {
  for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111", "2a00:1450:4001::1"]) {
    test(ip, () => assert.equal(isPublicAddress(ip), true));
  }
});

describe("isPublicAddress: IPv4-mapeado em IPv6 valida o IPv4 embutido", () => {
  for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::ffff:0.0.0.0"]) {
    test(`bloqueia ${ip}`, () => assert.equal(isPublicAddress(ip), false));
  }
  for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808"]) {
    test(`permite ${ip}`, () => assert.equal(isPublicAddress(ip), true));
  }
});

describe("isPublicAddress: entrada que não é IP", () => {
  for (const value of ["", "localhost", "example.com", "127.1", "0x7f000001", "2130706433", "01.2.3.4", "1.2.3.4.5", "[::1]"]) {
    test(JSON.stringify(value), () => assert.equal(isPublicAddress(value), false));
  }
});

describe("canonicalAddress", () => {
  test("IPv4 fica igual", () => assert.equal(canonicalAddress("8.8.8.8"), "8.8.8.8"));
  test("IPv4-mapeado vira IPv4", () => assert.equal(canonicalAddress("::ffff:808:808"), "8.8.8.8"));
  test("IPv6 é normalizado", () => assert.equal(canonicalAddress("2001:4860:4860:0:0:0:0:8888"), "2001:4860:4860::8888"));
  test("IPv6 em maiúsculas", () => assert.equal(canonicalAddress("2001:DB8::1"), "2001:db8::1"));
  test("não-IP devolve null", () => assert.equal(canonicalAddress("example.com"), null));
});
