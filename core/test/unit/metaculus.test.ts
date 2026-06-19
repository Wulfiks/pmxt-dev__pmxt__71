import { describe, test, expect, beforeEach } from '@jest/globals';
import axios from 'axios';
import { MetaculusExchange } from '../../src/exchanges/metaculus';

jest.mock('axios', () => {
    const mockAxiosInstance = {
        get: jest.fn(),
        interceptors: {
            request: { use: jest.fn() },
            response: { use: jest.fn() },
        },
        defaults: { headers: { common: {} } },
    };
    return {
        __esModule: true,
        default: { create: jest.fn(() => mockAxiosInstance) },
        create: jest.fn(() => mockAxiosInstance),
    };
});

function getMockHttp() {
    const created = (axios.create as jest.Mock).mock.results;
    return created[created.length - 1].value;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const binaryPost = {
    id: 100,
    title: 'Will AI pass the Turing test by 2030?',
    url_title: 'ai-turing-test',
    page_url: '/questions/100/ai-turing-test/',
    question: {
        id: 200,
        title: 'Will AI pass the Turing test by 2030?',
        type: 'binary',
        aggregations: {
            recency_weighted: { centers: [0.72] },
        },
        scheduled_close_time: '2030-01-01T00:00:00Z',
    },
    nr_forecasters: 500,
    created_at: '2024-01-01T00:00:00Z',
};

const groupPost = {
    id: 300,
    title: 'Next US President',
    url_title: 'next-us-president',
    page_url: '/questions/300/next-us-president/',
    group_of_questions: {
        questions: [
            {
                id: 401,
                title: 'Will candidate A win?',
                type: 'binary',
                aggregations: { recency_weighted: { centers: [0.6] } },
                scheduled_close_time: '2028-11-05T00:00:00Z',
            },
            {
                id: 402,
                title: 'Will candidate B win?',
                type: 'binary',
                aggregations: { recency_weighted: { centers: [0.35] } },
                scheduled_close_time: '2028-11-05T00:00:00Z',
            },
            {
                id: 403,
                title: 'How many votes total?',
                type: 'numeric',
                aggregations: { recency_weighted: { centers: [150_000_000] } },
                scheduled_close_time: '2028-11-05T00:00:00Z',
            },
        ],
    },
    nr_forecasters: 1200,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetaculusExchange', () => {
    let exchange: MetaculusExchange;

    beforeEach(() => {
        jest.clearAllMocks();
        exchange = new MetaculusExchange({ apiToken: 'test-token' });
    });

    test('name returns Metaculus', () => {
        expect(exchange.name).toBe('Metaculus');
    });

    test('has only fetchMarkets and fetchEvents enabled', () => {
        expect(exchange.has.fetchMarkets).toBe(true);
        expect(exchange.has.fetchEvents).toBe(true);
        expect(exchange.has.createOrder).toBe(false);
        expect(exchange.has.cancelOrder).toBe(false);
        expect(exchange.has.fetchOrderBook).toBe(false);
        expect(exchange.has.fetchOHLCV).toBe(false);
    });

    describe('fetchMarkets', () => {
        test('binary question produces Yes/No outcomes with correct prices', async () => {
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [binaryPost] } });

            const markets = await exchange.fetchMarkets();

            expect(markets).toHaveLength(1);
            const m = markets[0];
            expect(m.marketId).toBe('200');
            expect(m.eventId).toBe('100');
            expect(m.outcomes).toHaveLength(2);
            expect(m.yes!.label).toBe('Yes');
            expect(m.yes!.price).toBeCloseTo(0.72);
            expect(m.no!.label).toBe('No');
            expect(m.no!.price).toBeCloseTo(0.28);
            expect(m.url).toContain('metaculus.com');
        });

        test('group_of_questions expands binary sub-questions into separate markets', async () => {
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [groupPost] } });

            const markets = await exchange.fetchMarkets();

            // Only binary questions (2 out of 3)
            expect(markets).toHaveLength(2);
            expect(markets[0].marketId).toBe('401');
            expect(markets[1].marketId).toBe('402');
            expect(markets[0].yes!.price).toBeCloseTo(0.6);
            expect(markets[1].yes!.price).toBeCloseTo(0.35);
        });

        test('empty response returns empty array', async () => {
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [] } });

            const markets = await exchange.fetchMarkets();
            expect(markets).toHaveLength(0);
        });

        test('query parameter filters markets by title', async () => {
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [binaryPost, groupPost] } });

            const markets = await exchange.fetchMarkets({ query: 'turing' });

            expect(markets).toHaveLength(1);
            expect(markets[0].title).toContain('Turing');
        });
    });

    describe('fetchEvents', () => {
        test('posts are mapped to unified events with nested markets', async () => {
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [binaryPost] } });

            const events = await exchange.fetchEvents();

            expect(events).toHaveLength(1);
            expect(events[0].id).toBe('100');
            expect(events[0].title).toBe('Will AI pass the Turing test by 2030?');
            expect(events[0].markets).toHaveLength(1);
        });

        test('group post produces event with multiple markets', async () => {
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [groupPost] } });

            const events = await exchange.fetchEvents();

            expect(events).toHaveLength(1);
            expect(events[0].markets).toHaveLength(2);
        });
    });

    describe('authorization', () => {
        test('apiToken is sent as Authorization header', async () => {
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [] } });

            await exchange.fetchMarkets();

            expect(http.get).toHaveBeenCalledWith(
                expect.stringContaining('/api/posts/'),
                expect.objectContaining({
                    headers: { Authorization: 'Token test-token' },
                }),
            );
        });

        test('no token omits Authorization header', async () => {
            const noTokenExchange = new MetaculusExchange();
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [] } });

            await noTokenExchange.fetchMarkets();

            expect(http.get).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ headers: {} }),
            );
        });
    });

    describe('edge cases', () => {
        test('missing aggregation defaults to 0.5 probability', async () => {
            const noAggPost = {
                ...binaryPost,
                question: {
                    ...binaryPost.question,
                    aggregations: {},
                },
            };
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [noAggPost] } });

            const markets = await exchange.fetchMarkets();
            expect(markets[0].yes!.price).toBeCloseTo(0.5);
            expect(markets[0].no!.price).toBeCloseTo(0.5);
        });

        test('non-binary questions are filtered out', async () => {
            const numericPost = {
                id: 500,
                title: 'Temperature forecast',
                page_url: '/questions/500/',
                question: {
                    id: 600,
                    title: 'Temperature forecast',
                    type: 'numeric',
                    aggregations: { recency_weighted: { centers: [25.5] } },
                },
            };
            const http = getMockHttp();
            http.get.mockResolvedValue({ data: { results: [numericPost] } });

            const markets = await exchange.fetchMarkets();
            expect(markets).toHaveLength(0);
        });
    });
});
