import {
  JiraAssignBodySchema, JiraBoardDTOSchema, JiraCommentBodySchema, JiraConnectBodySchema, JiraDisconnectBodySchema, JiraEditBodySchema,
  JiraIssueDetailDTOSchema, JiraSiteDTOSchema, JiraSitesDTOSchema, JiraTransitionBodySchema, type JiraView, type HostId,
} from '@luady/shared';
import type { z } from 'zod';
import { OkSchema } from './schemas.js';
import { checked, query, seg, type Verbs } from './verbs.js';

export type JiraConnectInput = z.input<typeof JiraConnectBodySchema>;
export type JiraEditInput = z.input<typeof JiraEditBodySchema>;

/**
 * Jira per office. Without a connection the reads answer 409 `jira_not_connected`. The token goes only into the
 * connect body.
 */
export function jiraRoutes({ get, post, put }: Verbs) {
  const office = (server: HostId): string => `/api/jira/${seg(server)}`;
  const issue = (server: HostId, key: string): string => `${office(server)}/issues/${seg(key)}`;
  return {
    jiraSites: () => get('/api/jira', JiraSitesDTOSchema),
    connectJira: async (server: HostId, body: JiraConnectInput) =>
      put(`${office(server)}/connection`, JiraSiteDTOSchema, checked(JiraConnectBodySchema, body)),
    disconnectJira: async (server: HostId, pin: string) =>
      post(`${office(server)}/disconnect`, OkSchema, checked(JiraDisconnectBodySchema, { pin })),
    jiraBoard: (server: HostId, view?: JiraView, refresh = false) =>
      get(`${office(server)}/board${query({ view, refresh: refresh ? 1 : undefined })}`, JiraBoardDTOSchema),
    jiraIssue: (server: HostId, key: string) => get(issue(server, key), JiraIssueDetailDTOSchema),
    transitionJira: async (server: HostId, key: string, transitionId: string) =>
      post(`${issue(server, key)}/transition`, JiraIssueDetailDTOSchema, checked(JiraTransitionBodySchema, { transitionId })),
    commentJira: async (server: HostId, key: string, text: string) =>
      post(`${issue(server, key)}/comment`, JiraIssueDetailDTOSchema, checked(JiraCommentBodySchema, { text })),
    editJira: async (server: HostId, key: string, body: JiraEditInput) =>
      put(issue(server, key), JiraIssueDetailDTOSchema, checked(JiraEditBodySchema, body)),
    assignJira: async (server: HostId, key: string, me: boolean) =>
      post(`${issue(server, key)}/assign`, JiraIssueDetailDTOSchema, checked(JiraAssignBodySchema, { me })),
  };
}
