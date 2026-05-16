'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../session-store', () => ({
    sessionStore: {
        getUserPreferences: jest.fn(),
        patchUserPreferences: jest.fn(),
    },
}));

const { sessionStore } = require('../session-store');
const preferencesRouter = require('./preferences');

describe('/api/preferences route', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns the authenticated user web-chat preferences', async () => {
        sessionStore.getUserPreferences.mockResolvedValue({
            kimibuilt_default_model: 'gpt-5.4-mini',
            kimibuilt_theme_preset: 'obsidian',
        });

        const app = express();
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/preferences', preferencesRouter);

        const response = await request(app).get('/api/preferences/web-chat');

        expect(response.status).toBe(200);
        expect(sessionStore.getUserPreferences).toHaveBeenCalledWith('phill', 'webChat');
        expect(response.body.preferences).toEqual({
            kimibuilt_default_model: 'gpt-5.4-mini',
            kimibuilt_theme_preset: 'obsidian',
        });
    });

    test('persists only supported web-chat preference keys', async () => {
        sessionStore.patchUserPreferences.mockResolvedValue({
            kimibuilt_default_model: 'gpt-5.4',
            kimibuilt_remote_build_autonomy: 'false',
            kimibuilt_web_chat_workspace_host_active: 'workspace-3',
        });

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/preferences', preferencesRouter);

        const response = await request(app)
            .put('/api/preferences/web-chat')
            .send({
                preferences: {
                    kimibuilt_default_model: 'gpt-5.4',
                    kimibuilt_remote_build_autonomy: 'false',
                    kimibuilt_web_chat_workspace_host_active: 'workspace-3',
                    kimibuilt_models_cache: '{"ignore":true}',
                    arbitrary: 'ignore-me',
                },
            });

        expect(response.status).toBe(200);
        expect(sessionStore.patchUserPreferences).toHaveBeenCalledWith('phill', 'webChat', {
            kimibuilt_default_model: 'gpt-5.4',
            kimibuilt_remote_build_autonomy: 'false',
            kimibuilt_web_chat_workspace_host_active: 'workspace-3',
        });
        expect(response.body.preferences).toEqual({
            kimibuilt_default_model: 'gpt-5.4',
            kimibuilt_remote_build_autonomy: 'false',
            kimibuilt_web_chat_workspace_host_active: 'workspace-3',
        });
    });

    test('allows null values to remove persisted preference keys', async () => {
        sessionStore.patchUserPreferences.mockResolvedValue({
            kimibuilt_theme_preset: 'paper',
        });

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/preferences', preferencesRouter);

        const response = await request(app)
            .put('/api/preferences/web-chat')
            .send({
                preferences: {
                    kimibuilt_reasoning_effort: null,
                    kimibuilt_theme_preset: 'paper',
                },
            });

        expect(response.status).toBe(200);
        expect(sessionStore.patchUserPreferences).toHaveBeenCalledWith('phill', 'webChat', {
            kimibuilt_reasoning_effort: null,
            kimibuilt_theme_preset: 'paper',
        });
    });
});
