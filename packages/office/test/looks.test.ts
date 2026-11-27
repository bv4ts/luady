import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/layout.js';
import { hashBytes, hashId, lookFor } from '../src/looks.js';
import { buildSnapshot } from '../src/snapshot.js';
import { ALL_SERVERS, NOW, luadyStatus, session } from './fixtures.js';
import { CLASSIC_ROOMS, classicRooms } from './rooms-fixture.js';

const map = buildOffice(classicRooms(['cedar', 'birch', 'ash', 'local']));

/** Whether a session of this project on this host sits in its room as a guest: placement (roomOf) decides it. */
const guestOf = (host: string, project: string | null): boolean | undefined => {
  const id = `${host}:probe:0.0`;
  const snap = buildSnapshot({ servers: ALL_SERVERS, rooms: CLASSIC_ROOMS, sessions: [session(id, { project })], questions: [], luady: luadyStatus(), now: NOW, previousSeats: {} });
  return snap.actors[id]?.look.guest;
};

describe('hashId', () => {
  it('is 32-bit FNV-1a', () => {
    expect(hashId('a')).toBe(0xe40c292c);
    expect(hashId('')).toBe(0x811c9dc5);
    expect(hashId('foobar')).toBe(0xbf9cf968);
  });

  it('hashes the UTF-8 bytes of the id', () => {
    expect(hashId('é')).toBe(hashBytes(new Uint8Array([0xc3, 0xa9])));
    expect(hashId('\u{1f600}')).toBe(hashBytes(new Uint8Array([0xf0, 0x9f, 0x98, 0x80])));
    expect(hashId('م')).toBe(hashBytes(new Uint8Array([0xd9, 0x85])));
    expect(hashId('€')).toBe(hashBytes(new Uint8Array([0xe2, 0x82, 0xac])));
  });

  it('is unsigned', () => {
    expect(['birch:main:0.1', 'x', 'zz', 'cedar:w:1.2'].every((id) => hashId(id) >= 0 && hashId(id) <= 0xffffffff)).toBe(true);
  });
});

describe('lookFor', () => {
  it('takes the species, palette and team from the room', () => {
    expect(lookFor('birch:main:0.1', map.rooms.birch!, false)).toMatchObject({ species: 'bun', guest: false, palette: { base: '#d6336c', accent: '#74b816' } });
    expect(lookFor('ash:main:0.1', map.rooms.ash!, false)).toMatchObject({ species: 'bot', guest: false, palette: { base: '#f76707', accent: '#37b24d' } });
    expect(guestOf('birch', 'orchard')).toBe(false);
    expect(guestOf('ash', null)).toBe(false);
  });

  it('is the same every time for one id, with a variant 0..5 from the hash', () => {
    const id = 'cedar:meadow:1.0';
    const look = lookFor(id, map.rooms.cedar!, false);
    expect(lookFor(id, map.rooms.cedar!, false)).toEqual(look);
    expect(look.variant).toBe(hashId(id) % 6);
    const variants = new Set(Array.from({ length: 60 }, (_, i) => lookFor(`id-${i}`, map.rooms.cedar!, false).variant));
    expect([...variants].every((v) => Number.isInteger(v) && v >= 0 && v <= 5)).toBe(true);
    expect(variants.size).toBe(6);
  });

  it('marks guests by project', () => {
    expect(guestOf('cedar', 'fitness-demo')).toBe(true);
    expect(guestOf('cedar', 'meadow-vat')).toBe(false);
    expect(guestOf('local', 'anything')).toBe(false);
    expect(lookFor('a', map.rooms.cedar!, true).guest).toBe(true);
  });

  it('never marks a guest outside furnished rooms', () => {
    expect(lookFor('a', map.rooms.hq!, true)).toMatchObject({ guest: false, species: 'manager', palette: { base: '#3cc3b0', accent: '#ffd84d' } });
    expect(lookFor('a', buildOffice(classicRooms(['birch'])).rooms['lot-1']!, true).guest).toBe(false);
  });

  it('returns a frozen look', () => {
    expect(Object.isFrozen(lookFor('a', map.rooms.birch!, false))).toBe(true);
  });
});
