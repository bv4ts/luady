import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { roomProblem } from '../../../src/features/rooms/room-errors.js';
import {
  createBody, defaultColour, defaultSpecies, editRoomForm, isNoChange, isValid, nameForHost, newRoomForm, savedColour, updateBody,
  validateRoomForm,
} from '../../../src/features/rooms/room-form.js';
import type { HostChoice } from '../../../src/state/rooms.js';
import { classicRoomDtos, roomDto } from '../../room-fixtures.js';

const ssh = (id: string, projectsRoot: string | null = null): HostChoice => ({ id, local: false, projectsRoot, homeDir: null });
const LOCAL: HostChoice = { id: 'computer', local: true, projectsRoot: '/home/me/projects', homeDir: '/home/me' };

describe('a new room starts ready to save', () => {
  it('picks the first server without a room, names it from the host, and takes the next colour and species', () => {
    const rooms = classicRoomDtos();
    const form = newRoomForm(rooms, [ssh('birch'), ssh('mars-01'), LOCAL]);
    expect(form).toMatchObject({ kind: 'server', host: 'mars-01', name: 'Mars 01', species: 'cat' });
    expect(form.colour).toBe(defaultColour(rooms));
    expect(isValid(validateRoomForm(form, { rooms, hosts: [ssh('birch'), ssh('mars-01'), LOCAL], self: null }))).toBe(true);
  });

  it('defaults follow the hub: the first unused palette colour, the species cycle by room count', () => {
    expect(defaultColour([])).toBe('#d6336c');
    expect(defaultColour([roomDto({ colour: '#d6336c' })])).toBe('#f76707');
    expect(defaultSpecies([])).toBe('bun');
    expect(defaultSpecies(classicRoomDtos())).toBe('cat');
    expect(defaultSpecies([...classicRoomDtos(), roomDto({ id: 'x', position: 9 })])).toBe('bun');
  });

  it('offers this computer when every server has its room', () => {
    const rooms = [roomDto({ id: 'mars', host: 'mars' })];
    expect(newRoomForm(rooms, [ssh('mars'), LOCAL])).toMatchObject({ kind: 'local', host: 'computer', name: 'This computer' });
  });

  it('falls back to a project room when no host is free', () => {
    expect(newRoomForm([], [])).toMatchObject({ kind: 'project', host: '', name: '' });
    expect(nameForHost(undefined)).toBe('');
  });
});

describe('validation messages say what to do', () => {
  const rooms = classicRoomDtos();
  const hosts = [ssh('mars', '/srv/work'), LOCAL];
  const base = newRoomForm(rooms, hosts);
  const check = (over: Partial<typeof base>, self: string | null = null) => validateRoomForm({ ...base, ...over }, { rooms, hosts, self });

  it('names: empty, too long, taken (any case), HQ', () => {
    expect(check({ name: '  ' }).fields.name).toBe('Give the room a name.');
    expect(check({ name: 'x'.repeat(41) }).fields.name).toBe('Keep the name to 40 characters or fewer.');
    expect(check({ name: 'harbor' }).fields.name).toBe('Another room is already called “Harbor”. Pick a different name.');
    expect(check({ name: 'hq' }).fields.name).toBe('That name belongs to HQ. Pick a different name.');
    expect(check({ name: 'Harbor' }, 'ash').fields.name).toBeUndefined();
  });

  it('short names and colours', () => {
    expect(check({ short: 'x'.repeat(13) }).fields.short).toBe('Keep the short name to 12 characters or fewer.');
    expect(check({ colour: 'blue' }).fields.colour).toBe('Enter a colour like #3d7bff, or pick one of the swatches.');
  });

  it('a project room needs a match; each row is checked, path rows inside the host\'s folder', () => {
    expect(check({ kind: 'project', host: '' }).fields.match).toBe('A project room needs at least one project name or folder.');
    const rows = check({
      kind: 'project', host: 'mars',
      match: [{ by: 'name', glob: 'web-*' }, { by: 'name', glob: 'web app' }, { by: 'path', glob: '/srv/work/api/**' },
        { by: 'path', glob: '/etc/**' }, { by: 'path', glob: '/srv/../etc' }, { by: 'name', glob: '' }],
    }).rows;
    expect(rows).toEqual([
      null, 'Use letters, digits, dots, dashes, underscores, * and ? only.', null,
      'This folder is outside /srv/work. Pick a folder inside it.', 'Start with / and use letters, digits, . _ - / * and ? only.',
      'Type a project name, like web-app or web-*.',
    ]);
  });

  it('a server room needs a free server', () => {
    const full = validateRoomForm({ ...base, kind: 'server', host: '' }, { rooms: [roomDto({ host: 'mars' })], hosts: [ssh('mars')], self: null });
    expect(full.fields.host).toBe('Every server has its room already. Add a server first, or make a project room.');
  });
});

describe('the clamp preview and the bodies', () => {
  it('shows the colour the room will really get', () => {
    expect(savedColour({ colour: '#3D7BFF' })).toEqual({ hex: '#3d7bff', adjusted: false });
    const dark = savedColour({ colour: '#000010' });
    expect(dark?.adjusted).toBe(true);
    expect(dark?.hex).not.toBe('#000010');
    expect(savedColour({ colour: 'nope' })).toBeNull();
  });

  it('creates with the clamped colour, and a chosen slot', () => {
    const form = { ...newRoomForm([], [ssh('mars')]), colour: '#FFFFFF' };
    const body = createBody(form, 6);
    expect(body).toMatchObject({ name: 'Mars', kind: 'server', host: 'mars', species: 'bun', position: 6 });
    expect(body.colour).toBe(savedColour(form)?.hex);
  });

  it('updates only what changed, with expectUpdatedAt, and a new accent with a new colour', () => {
    const room = roomDto();
    expect(isNoChange(updateBody(editRoomForm(room), room))).toBe(true);
    const body = updateBody({ ...editRoomForm(room), name: 'Red planet', colour: '#c4512b' }, room);
    expect(body).toMatchObject({ expectUpdatedAt: room.updatedAt, name: 'Red planet', colour: '#c4512b' });
    expect(body.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(body).not.toHaveProperty('species');
  });
});

describe('refusals in plain words', () => {
  it.each([
    ['room_conflict', 409, 'This room was changed on another screen. Load the newest version, then make your change again.'],
    ['name_taken', 409, 'Another room already has this name. Pick a different name.'],
    ['room_exists', 409, 'A room with this name existed before. Pick a different name.'],
    ['jira_exists', 409, 'The room you picked already has a Jira board. Pick another room for it, or disconnect this one.'],
    ['home_room_exists', 409, 'This server already has its own room. Pick another server, or make a project room for it instead.'],
    ['position_taken', 409, 'That spot on the map was just taken. Pick another free spot, or let the office choose one.'],
    ['position_outside_grid', 400, 'That spot is outside the office. Pick a free spot inside it, or let the office choose one.'],
    ['not_a_permutation', 400, 'The list of rooms changed while you were sorting it. Look at the newest list and try again.'],
    ['move_target', 400, 'Pick the room that should get this room\'s links and Jira board.'],
    ['reserved_id', 400, 'That name is reserved for the office itself. Pick a different name.'],
    ['pin_required', 428, 'Enter your PIN to disconnect the Jira board.'],
    ['pin_invalid', 403, 'That PIN is not right. Try again.'],
    ['pin_locked', 423, 'Too many wrong PINs. Wait a few minutes, then try again.'],
    ['not_found', 404, 'This room is gone: it was removed on another screen.'],
  ])('%s', (code, status, text) => {
    const problem = roomProblem(new ApiError(status, code, `raw ${code} message with an id`));
    expect(problem.text).toBe(text);
    expect(problem.text).not.toContain(code);
    expect(problem.stale).toBe(code === 'room_conflict');
  });

  it('a hub check keeps its sentence as written and adds what to do, with one full stop', () => {
    const say = (message: string) => roomProblem(new ApiError(400, 'validation', message)).text;
    expect(say('A room name needs 1-40 characters')).toBe('A room name needs 1-40 characters. Change it and try again.');
    expect(say('A room name needs 1-40 characters.')).toBe('A room name needs 1-40 characters. Change it and try again.');
    // The owner's own text in the sentence (a path with "..") is shown exactly as typed.
    expect(say('/home/dev/projects/../etc is outside the projects folder /home/dev/projects'))
      .toBe('/home/dev/projects/../etc is outside the projects folder /home/dev/projects. Change it and try again.');
    expect(say('Not a name match: "a..b/" (letters, digits, . _ - * ?).'))
      .toBe('Not a name match: "a..b/" (letters, digits, . _ - * ?). Change it and try again.');
  });
});
