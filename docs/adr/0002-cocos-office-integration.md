# ADR 0002: Embed the Cocos personal office in React

## Status

Accepted for Phase 3.

## Context

The office is a read-only spatial presentation of existing Agent Market data. Authentication is an HttpOnly session cookie and business navigation already belongs to React Router.

## Options

1. Embed a Cocos Web Desktop build in React `/office`. This shares the existing origin and session, keeps routing and fallback UI in React, and can be rolled back by removing one route and its static assets.
2. Deploy an independent Cocos web application. This isolates asset delivery but introduces another deployment, cross-origin cookie/CORS configuration, duplicated base-URL routing, and a second rollback boundary.

## Decision

Use option 1. Cocos reads one `GET /office/snapshot` contract and sends typed navigation intents to its React parent. It does not call task, wallet, settlement, or contract mutation APIs.

## Failure and rollback

If the iframe, WebGL runtime, or Cocos assets fail, `/office` exposes the normal Web workbench. The office route and static Cocos build can be removed without changing the underlying Agent, task, wallet, or escrow flows.
