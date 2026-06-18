import {
    PredictionMarketExchange,
    MarketFilterParams,
    EventFetchParams,
    ExchangeCredentials,
} from '../../BaseExchange';
import { UnifiedMarket, UnifiedEvent } from '../../types';
import { addBinaryOutcomes } from '../../utils/market-utils';

const METACULUS_API = 'https://www.metaculus.com/api';

interface MetaculusAggregation {
    centers?: number[];
    means?: number[];
}

interface MetaculusQuestion {
    id: number;
    title: string;
    description?: string;
    type?: string;
    aggregations?: {
        recency_weighted?: MetaculusAggregation;
    };
    scheduled_close_time?: string;
    created_at?: string;
}

interface MetaculusPost {
    id: number;
    title: string;
    url_title?: string;
    page_url?: string;
    question?: MetaculusQuestion;
    group_of_questions?: {
        questions: MetaculusQuestion[];
    };
    nr_forecasters?: number;
    created_at?: string;
    scheduled_close_time?: string;
}

function extractProbability(q: MetaculusQuestion): number {
    const agg = q.aggregations?.recency_weighted;
    if (agg?.centers?.length) return agg.centers[0];
    if (agg?.means?.length) return agg.means[0];
    return 0.5;
}

function questionToMarket(q: MetaculusQuestion, post: MetaculusPost): UnifiedMarket {
    const prob = extractProbability(q);
    const postUrl = post.page_url
        ? `https://www.metaculus.com${post.page_url}`
        : `https://www.metaculus.com/questions/${post.id}/`;

    const market: UnifiedMarket = {
        marketId: String(q.id),
        eventId: String(post.id),
        title: q.title || post.title,
        description: q.description || '',
        slug: post.url_title,
        outcomes: [
            { outcomeId: `${q.id}-yes`, label: 'Yes', price: prob },
            { outcomeId: `${q.id}-no`, label: 'No', price: 1 - prob },
        ],
        resolutionDate: new Date(q.scheduled_close_time || post.scheduled_close_time || 0),
        volume24h: 0,
        liquidity: 0,
        url: postUrl,
    };

    addBinaryOutcomes(market);
    return market;
}

function postToMarkets(post: MetaculusPost): UnifiedMarket[] {
    if (post.group_of_questions?.questions?.length) {
        return post.group_of_questions.questions
            .filter(q => q.type === 'binary')
            .map(q => questionToMarket(q, post));
    }

    if (post.question?.type === 'binary') {
        return [questionToMarket(post.question, post)];
    }

    return [];
}

function postToEvent(post: MetaculusPost, markets: UnifiedMarket[]): UnifiedEvent {
    const postUrl = post.page_url
        ? `https://www.metaculus.com${post.page_url}`
        : `https://www.metaculus.com/questions/${post.id}/`;

    return {
        id: String(post.id),
        title: post.title,
        description: '',
        slug: post.url_title || '',
        markets,
        volume24h: 0,
        url: postUrl,
        category: 'Forecasting',
    };
}

export class MetaculusExchange extends PredictionMarketExchange {
    override readonly has = {
        fetchMarkets: true as const,
        fetchEvents: true as const,
        fetchOHLCV: false as const,
        fetchOrderBook: false as const,
        fetchTrades: false as const,
        createOrder: false as const,
        cancelOrder: false as const,
        fetchOrder: false as const,
        fetchOpenOrders: false as const,
        fetchPositions: false as const,
        fetchBalance: false as const,
        watchAddress: false as const,
        unwatchAddress: false as const,
        watchOrderBook: false as const,
        watchTrades: false as const,
        fetchMyTrades: false as const,
        fetchClosedOrders: false as const,
        fetchAllOrders: false as const,
        buildOrder: false as const,
        submitOrder: false as const,
    };

    private readonly apiToken?: string;

    constructor(credentials?: ExchangeCredentials) {
        super(credentials);
        this.rateLimit = 500;
        this.apiToken = credentials?.apiToken;
    }

    get name(): string {
        return 'Metaculus';
    }

    protected async fetchMarketsImpl(params?: MarketFilterParams): Promise<UnifiedMarket[]> {
        const posts = await this.fetchPosts(params);
        const allMarkets = posts.flatMap(postToMarkets);

        if (params?.query) {
            const lq = params.query.toLowerCase();
            const searchIn = params.searchIn || 'title';
            return allMarkets.filter(m => {
                const titleHit = m.title.toLowerCase().includes(lq);
                const descHit = (m.description || '').toLowerCase().includes(lq);
                if (searchIn === 'description') return descHit;
                if (searchIn === 'both') return titleHit || descHit;
                return titleHit;
            }).slice(0, params.limit || 100_000);
        }

        const offset = params?.offset || 0;
        const limit = params?.limit || 100_000;
        return allMarkets.slice(offset, offset + limit);
    }

    protected async fetchEventsImpl(params: EventFetchParams): Promise<UnifiedEvent[]> {
        const posts = await this.fetchPosts(params);
        const events: UnifiedEvent[] = [];

        for (const post of posts) {
            const markets = postToMarkets(post);
            if (!markets.length) continue;
            events.push(postToEvent(post, markets));
        }

        if (params.query) {
            const lq = params.query.toLowerCase();
            return events
                .filter(e => e.title.toLowerCase().includes(lq))
                .slice(0, params.limit || 10_000);
        }

        return events.slice(0, params.limit || 10_000);
    }

    private async fetchPosts(params?: { limit?: number; offset?: number }): Promise<MetaculusPost[]> {
        const headers: Record<string, string> = {};
        if (this.apiToken) {
            headers['Authorization'] = `Token ${this.apiToken}`;
        }

        const { data } = await this.http.get(`${METACULUS_API}/posts/`, {
            params: {
                type: 'forecast',
                limit: params?.limit || 100,
                offset: params?.offset || 0,
            },
            headers,
        });

        return data?.results || [];
    }
}
