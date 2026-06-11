/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');
const audit = require('audit').default;

type AuditStreamItem = {
  id: string;
  name: string;
  parentId: string | null;
  children: AuditStreamItem[];
  childrenHidden?: boolean;
  trashed?: boolean;
};

type StreamQueryLike = {
  parentId?: string | null;
  [k: string]: unknown;
};

type AuditAccess = { term: string };
type AuditAction = { term: string };

interface AuditUserStreams {
  get (userId: string, query: StreamQueryLike): Promise<AuditStreamItem[]>;
  getOne (userId: string, streamId: string, query: StreamQueryLike): Promise<AuditStreamItem | null>;
}

/**
 * Children id: `access-{accessId}`
 */
const accessesStream: AuditStreamItem = {
  id: 'accesses',
  name: 'Accesses',
  parentId: null,
  children: [],
  childrenHidden: true
};
Object.freeze(accessesStream);
/**
 * Children id: `action-{actionId}`
 */
const actionsStream: AuditStreamItem = {
  id: 'actions',
  name: 'Actions',
  parentId: null,
  children: [],
  childrenHidden: true
};
Object.freeze(actionsStream);

const auditStreams: AuditStreamItem[] = [accessesStream, actionsStream];
Object.freeze(auditStreams);

const auditUserStreams: AuditUserStreams = ds.createUserStreams({
  async get (userId: string, query: StreamQueryLike): Promise<AuditStreamItem[]> {
    if (query.parentId === '*' || query.parentId == null) {
      // Return fresh clones: `auditStreams` and its members are Object.freeze'd
      // module-scope singletons. The caller (mall's addStoreIdPrefixToStreams)
      // mutates stream.id in place — that mutation silently no-op'd in
      // pre-strict CJS but throws TypeError under ESM strict mode. Cloning
      // gives the caller mutable copies without exposing the singleton state.
      return auditStreams.map((s) => ({ ...s, children: [...s.children] }));
    }
    const parent = await this.getOne(userId, query.parentId, query);
    if (parent == null) return [];
    return parent.children;
  },

  async getOne (userId: string, streamId: string, query: StreamQueryLike): Promise<AuditStreamItem | null> {
    // list accesses
    if (streamId === accessesStream.id) {
      const userStorage = await audit.storage.forUser(userId);
      const accesses = await userStorage.getAllAccesses();
      if (accesses == null) return null;
      const res: AuditStreamItem[] = accesses.map((access: AuditAccess) => {
        return {
          id: access.term,
          name: access.term,
          children: [],
          parentId: accessesStream.id
        };
      });
      return Object.assign({}, accessesStream, {
        children: res,
        childrenHidden: false
      });
    }

    // list actions
    if (streamId === actionsStream.id) {
      const userStorage = await audit.storage.forUser(userId);
      const actions = await userStorage.getAllActions();
      if (actions == null) return null;
      const res: AuditStreamItem[] = actions.map((action: AuditAction) => {
        return {
          id: action.term,
          name: action.term,
          children: [],
          parentId: actionsStream.id
        };
      });
      return Object.assign({}, actionsStream, {
        children: res,
        childrenHidden: false
      });
    }

    if (streamId) {
      let parentId: string | null = null;
      if (streamId.startsWith('access-')) {
        parentId = accessesStream.id;
      } else if (streamId.startsWith('action-')) {
        parentId = actionsStream.id;
      }
      // here check that this access or action stream exists
      return {
        id: streamId,
        name: streamId,
        parentId,
        children: [],
        trashed: false
      };
    }

    return null;
  }
});
export default auditUserStreams;
export { auditUserStreams };
