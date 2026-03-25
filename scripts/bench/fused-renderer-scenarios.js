'use strict';

/**
 * Realistic test scenarios for the fused renderer benchmark.
 *
 * Each scenario simulates a real app page with:
 * - Async server components (simulated DB/cache fetches)
 * - Realistic prop sizes (blog posts, product listings, user objects)
 * - Suspense boundaries for streaming
 * - Mixed server/client component boundaries
 */

const {
  generateBlogPost,
  generateProduct,
  generateUser,
} = require('./fused-renderer-data');

// ---------------------------------------------------------------------------
// Async delay — simulates cache/DB lookup latency
// ---------------------------------------------------------------------------

function simulateDbFetch(ms) {
  // Simulates a cache hit or DB query. Even fast cache lookups have
  // real latency from async scheduling, promise resolution, and
  // microtask queue processing.
  return new Promise(resolve => {
    if (ms <= 0) {
      // Minimum: still async — goes through microtask queue
      Promise.resolve().then(resolve);
    } else {
      setTimeout(resolve, ms);
    }
  });
}

// Fetch delay presets (milliseconds) — these simulate real-world latencies.
// Even with Redis/Memcached, reads are 0.5-2ms. DB queries are 2-20ms.
// External API calls are 10-100ms.
const FETCH_DELAYS = {
  cacheHit: 1, // fast in-memory cache (Redis)
  dbQuery: 5, // simple indexed DB query
  dbQuerySlow: 12, // complex join or unindexed query
  apiCall: 20, // internal microservice call
};

// ---------------------------------------------------------------------------
// Scenario factory
// ---------------------------------------------------------------------------

function createScenarios(ServerReact, React, clientExports) {
  const se = ServerReact.createElement;
  const ce = React.createElement;
  const Suspense = ServerReact.Suspense;

  function createClientComponent(name, renderFn) {
    return clientExports(renderFn);
  }

  // Context creation uses React (client) since ServerReact doesn't export
  // createContext. In the actual pipeline, Flight serializes context values
  // and Fizz renders them — the context objects work across both.
  // For benchmarking purposes, we simulate context propagation by passing
  // config objects through the tree as props (same serialization cost).
  const appConfig = {
    theme: 'dark',
    locale: 'en-US',
    featureFlags: {newCheckout: true, darkMode: true, beta: false},
  };

  // ---------------------------------------------------------------------------
  // Shared client components (used across scenarios)
  // ---------------------------------------------------------------------------

  const ClientInteractiveCard = createClientComponent(
    'ClientInteractiveCard',
    function ClientInteractiveCard({product}) {
      return ce(
        'div',
        {className: 'product-card', 'data-id': product.id},
        ce('img', {src: product.images[0].url, alt: product.images[0].alt}),
        ce('h3', null, product.name),
        ce('p', {className: 'description'}, product.description.slice(0, 100)),
        ce(
          'div',
          {className: 'price'},
          ce('span', {className: 'current'}, product.price.formatted),
          product.price.compareAt
            ? ce('span', {className: 'compare'}, '$' + product.price.compareAt)
            : null
        ),
        ce(
          'div',
          {className: 'rating'},
          '★'.repeat(Math.round(parseFloat(product.rating.average))),
          ce('span', null, ` (${product.rating.count} reviews)`)
        ),
        ce(
          'div',
          {className: 'actions'},
          ce('button', {className: 'add-to-cart'}, 'Add to Cart'),
          ce('button', {className: 'wishlist'}, '♡')
        )
      );
    }
  );

  const ClientCommentForm = createClientComponent(
    'ClientCommentForm',
    function ClientCommentForm({postId, user}) {
      return ce(
        'form',
        {className: 'comment-form'},
        ce('textarea', {placeholder: 'Write a comment...', rows: 4}),
        ce(
          'div',
          {className: 'form-footer'},
          ce('span', null, `Commenting as ${user ? user.name : 'Guest'}`),
          ce('button', {type: 'submit'}, 'Post Comment')
        )
      );
    }
  );

  const ClientSearchFilters = createClientComponent(
    'ClientSearchFilters',
    function ClientSearchFilters({categories, priceRange, activeFilters}) {
      return ce(
        'aside',
        {className: 'filters'},
        ce('h3', null, 'Filters'),
        ce(
          'div',
          {className: 'filter-group'},
          ce('h4', null, 'Categories'),
          categories.map((cat, i) =>
            ce(
              'label',
              {key: i, className: 'filter-option'},
              ce('input', {
                type: 'checkbox',
                checked: activeFilters.includes(cat.name),
              }),
              cat.name
            )
          )
        ),
        ce(
          'div',
          {className: 'filter-group'},
          ce('h4', null, 'Price Range'),
          ce('input', {
            type: 'range',
            min: priceRange.min,
            max: priceRange.max,
          })
        )
      );
    }
  );

  const ClientNavbar = createClientComponent(
    'ClientNavbar',
    function ClientNavbar({user, cartCount, categories}) {
      return ce(
        'nav',
        {className: 'navbar'},
        ce('a', {href: '/', className: 'logo'}, 'StoreName'),
        ce(
          'div',
          {className: 'nav-links'},
          categories
            .slice(0, 5)
            .map((cat, i) =>
              ce('a', {key: i, href: `/category/${cat.slug}`}, cat.name)
            )
        ),
        ce(
          'div',
          {className: 'nav-actions'},
          ce('input', {type: 'search', placeholder: 'Search...'}),
          ce('a', {href: '/cart'}, `Cart (${cartCount})`),
          user
            ? ce('span', null, user.name)
            : ce('a', {href: '/login'}, 'Sign In')
        )
      );
    }
  );

  // ---------------------------------------------------------------------------
  // Scenario: Blog page (content-heavy, async data, comments)
  // ---------------------------------------------------------------------------

  function buildBlogScenario() {
    const posts = Array.from({length: 10}, (_, i) => generateBlogPost(i));
    const user = generateUser();

    // Async server components that simulate DB fetches
    const ServerBlogPost = function ServerBlogPost({postId, fetchDelay}) {
      return simulateDbFetch(fetchDelay).then(() => {
        const post = posts[postId % posts.length];
        return se(
          'article',
          {className: 'blog-post'},
          se('h1', null, post.title),
          se(
            'div',
            {className: 'meta'},
            se('span', null, `By ${post.author.name}`),
            se('span', null, ` · ${post.readingTime} min read`),
            se('time', null, post.publishedAt)
          ),
          se('img', {src: post.coverImage.url, alt: post.coverImage.alt}),
          se('div', {className: 'content'}, post.content),
          se(
            'div',
            {className: 'tags'},
            post.tags.map((tag, i) =>
              se('a', {key: i, href: `/tag/${tag}`}, '#' + tag)
            )
          )
        );
      });
    };

    const ServerRelatedPosts = function ServerRelatedPosts({fetchDelay}) {
      return simulateDbFetch(fetchDelay).then(() =>
        se(
          'section',
          {className: 'related'},
          se('h2', null, 'Related Posts'),
          se(
            'div',
            {className: 'related-grid'},
            posts.slice(3, 7).map((post, i) =>
              se(
                'a',
                {
                  key: i,
                  href: `/posts/${post.slug}`,
                  className: 'related-card',
                },
                se('img', {
                  src: post.coverImage.url,
                  alt: post.coverImage.alt,
                }),
                se('h3', null, post.title),
                se('p', null, post.excerpt)
              )
            )
          )
        )
      );
    };

    const ServerComments = function ServerComments({postId, fetchDelay}) {
      return simulateDbFetch(fetchDelay).then(() =>
        se(
          'section',
          {className: 'comments'},
          se('h2', null, '24 Comments'),
          Array.from({length: 8}, (_, i) =>
            se(
              'div',
              {key: i, className: 'comment'},
              se(
                'div',
                {className: 'comment-header'},
                se('strong', null, `Commenter ${i}`),
                se('time', null, `${i + 1} hours ago`)
              ),
              se(
                'p',
                null,
                'Great article! '.repeat(2 + (i % 3)) +
                  'I found the section on server components particularly insightful.'
              )
            )
          ),
          se(ClientCommentForm, {postId, user})
        )
      );
    };

    const ServerSidebar = function ServerSidebar({fetchDelay}) {
      return simulateDbFetch(fetchDelay).then(() =>
        se(
          'aside',
          {className: 'sidebar'},
          se('h3', null, 'Popular Posts'),
          posts.slice(0, 5).map((post, i) =>
            se(
              'a',
              {
                key: i,
                href: `/posts/${post.slug}`,
                className: 'sidebar-link',
              },
              se('span', {className: 'rank'}, `${i + 1}.`),
              post.title
            )
          ),
          se(
            'div',
            {className: 'newsletter'},
            se('h3', null, 'Newsletter'),
            se('p', null, 'Get the latest posts delivered to your inbox.')
          )
        )
      );
    };

    const App = function App() {
      return se(
        'div',
        null,
        se(
          'div',
          null,
          se(
            'div',
            null,
            se(
              'div',
              {id: 'app', className: 'blog-layout'},
              se(ClientNavbar, {
                user,
                cartCount: 3,
                categories: posts.slice(0, 5).map(p => p.category),
              }),
              se(
                'div',
                {className: 'main-layout'},
                se(
                  'main',
                  null,
                  se(
                    Suspense,
                    {fallback: se('div', null, 'Loading post...')},
                    se(ServerBlogPost, {
                      postId: 0,
                      fetchDelay: FETCH_DELAYS.dbQuery,
                    })
                  ),
                  se(
                    Suspense,
                    {fallback: se('div', null, 'Loading comments...')},
                    se(ServerComments, {
                      postId: 0,
                      fetchDelay: FETCH_DELAYS.dbQuerySlow,
                    })
                  )
                ),
                se(
                  Suspense,
                  {fallback: se('div', null, 'Loading sidebar...')},
                  se(ServerSidebar, {fetchDelay: FETCH_DELAYS.cacheHit})
                )
              ),
              se(
                Suspense,
                {fallback: se('div', null, 'Loading related...')},
                se(ServerRelatedPosts, {fetchDelay: FETCH_DELAYS.dbQuery})
              ),
              se('footer', null, se('p', null, '© 2026 Blog Inc.'))
            )
          )
        )
      );
    };

    return {
      tree: se(App, null),
      name: 'blog',
      description:
        'Blog page: 4 async fetches (1-12ms each), 4 Suspense boundaries, ' +
        'rich text content (~40KB), 3 context providers, comment form (client)',
      componentCount: 60,
    };
  }

  // ---------------------------------------------------------------------------
  // Scenario: E-commerce PLP (product listing, filters, pagination)
  // ---------------------------------------------------------------------------

  function buildEcommercePLPScenario() {
    const products = Array.from({length: 48}, (_, i) => generateProduct(i));
    const user = generateUser();
    const categories = Array.from({length: 12}, (_, i) => ({
      id: i,
      name: `Category ${i}`,
      slug: `category-${i}`,
      count: 20 + i * 5,
    }));

    const ServerProductGrid = function ServerProductGrid({fetchDelay}) {
      return simulateDbFetch(fetchDelay).then(() =>
        se(
          'div',
          {className: 'product-grid'},
          se(
            'div',
            {className: 'grid-header'},
            se('h2', null, `Showing ${products.length} products`),
            se('span', null, 'Page 1 of 4')
          ),
          se(
            'div',
            {className: 'grid'},
            products.map((product, i) =>
              se(ClientInteractiveCard, {key: i, product})
            )
          )
        )
      );
    };

    const ServerBreadcrumbs = function ServerBreadcrumbs() {
      return se(
        'nav',
        {className: 'breadcrumbs'},
        ['Home', 'Electronics', 'Widgets', 'Professional Grade'].map(
          (item, i) =>
            se('span', {key: i}, i > 0 ? ' › ' : '', se('a', {href: '#'}, item))
        )
      );
    };

    const ServerRecommendations = function ServerRecommendations({fetchDelay}) {
      return simulateDbFetch(fetchDelay).then(() =>
        se(
          'section',
          {className: 'recommendations'},
          se('h2', null, 'Recommended for You'),
          se(
            'div',
            {className: 'rec-grid'},
            products
              .slice(0, 6)
              .map((product, i) => se(ClientInteractiveCard, {key: i, product}))
          )
        )
      );
    };

    const App = function App() {
      return se(
        'div',
        null,
        se(
          'div',
          null,
          se(
            'div',
            {id: 'app', className: 'ecommerce'},
            se(ClientNavbar, {user, cartCount: 2, categories}),
            se(ServerBreadcrumbs, null),
            se(
              'div',
              {className: 'plp-layout'},
              se(ClientSearchFilters, {
                categories,
                priceRange: {min: 0, max: 500},
                activeFilters: ['Category 0', 'Category 3'],
              }),
              se(
                'main',
                null,
                se(
                  Suspense,
                  {
                    fallback: se(
                      'div',
                      {className: 'skeleton-grid'},
                      'Loading products...'
                    ),
                  },
                  se(ServerProductGrid, {fetchDelay: FETCH_DELAYS.dbQuerySlow})
                )
              )
            ),
            se(
              Suspense,
              {
                fallback: se('div', null, 'Loading recommendations...'),
              },
              se(ServerRecommendations, {fetchDelay: FETCH_DELAYS.apiCall})
            ),
            se(
              'footer',
              {className: 'site-footer'},
              se(
                'div',
                {className: 'footer-links'},
                ['About', 'Privacy', 'Terms', 'Help', 'Careers'].map(
                  (item, i) => se('a', {key: i, href: '#'}, item)
                )
              )
            )
          )
        )
      );
    };

    return {
      tree: se(App, null),
      name: 'ecommerce-plp',
      description:
        'Product listing: 48 products (~150KB props), 54 client cards, ' +
        '2 async fetches (12-20ms each), 2 Suspense, filters (client), 2 contexts',
      componentCount: 120,
    };
  }

  // ---------------------------------------------------------------------------
  // Scenario: Dashboard (many small async fetches, heavy interactivity)
  // ---------------------------------------------------------------------------

  function buildDashboardScenario() {
    const user = generateUser();

    const ServerMetricCard = function ServerMetricCard({title, fetchDelay}) {
      return simulateDbFetch(fetchDelay).then(() =>
        se(
          'div',
          {className: 'metric-card'},
          se('h3', null, title),
          se(
            'div',
            {className: 'metric-value'},
            '$' + (Math.random() * 100000).toFixed(0)
          ),
          se(
            'div',
            {className: 'metric-change'},
            (Math.random() > 0.5 ? '+' : '-') +
              (Math.random() * 20).toFixed(1) +
              '%'
          )
        )
      );
    };

    const ClientChart = createClientComponent(
      'ClientChart',
      function ClientChart({data, type, title}) {
        return ce(
          'div',
          {className: 'chart', 'data-type': type},
          ce('h3', null, title),
          ce(
            'div',
            {className: 'chart-body'},
            ce(
              'svg',
              {width: 600, height: 300},
              ce('rect', {width: '100%', height: '100%', fill: '#f0f0f0'})
            )
          ),
          ce(
            'div',
            {className: 'chart-legend'},
            data.labels.map((label, i) =>
              ce('span', {key: i, className: 'legend-item'}, label)
            )
          )
        );
      }
    );

    const ClientDataTable = createClientComponent(
      'ClientDataTable',
      function ClientDataTable({rows, columns}) {
        return ce(
          'table',
          {className: 'data-table'},
          ce(
            'thead',
            null,
            ce(
              'tr',
              null,
              columns.map((col, i) => ce('th', {key: i}, col))
            )
          ),
          ce(
            'tbody',
            null,
            rows.map((row, i) =>
              ce(
                'tr',
                {key: i},
                row.map((cell, j) => ce('td', {key: j}, cell))
              )
            )
          )
        );
      }
    );

    const ServerRecentActivity = function ServerRecentActivity({fetchDelay}) {
      return simulateDbFetch(fetchDelay).then(() => {
        const rows = Array.from({length: 20}, (_, i) => [
          `Order #${1000 + i}`,
          `Customer ${i}`,
          `$${(Math.random() * 500).toFixed(2)}`,
          ['Completed', 'Pending', 'Shipped', 'Refunded'][i % 4],
          new Date(2026, 2, 25 - i).toLocaleDateString(),
        ]);
        return se(ClientDataTable, {
          rows,
          columns: ['Order', 'Customer', 'Amount', 'Status', 'Date'],
        });
      });
    };

    const ServerAnalytics = function ServerAnalytics({fetchDelay}) {
      return simulateDbFetch(fetchDelay).then(() =>
        se(ClientChart, {
          type: 'line',
          title: 'Revenue Over Time',
          data: {
            labels: [
              'Jan',
              'Feb',
              'Mar',
              'Apr',
              'May',
              'Jun',
              'Jul',
              'Aug',
              'Sep',
              'Oct',
              'Nov',
              'Dec',
            ],
            datasets: [
              {
                label: 'Revenue',
                data: Array.from({length: 12}, () =>
                  Math.floor(Math.random() * 100000)
                ),
              },
              {
                label: 'Expenses',
                data: Array.from({length: 12}, () =>
                  Math.floor(Math.random() * 50000)
                ),
              },
            ],
          },
        })
      );
    };

    const metrics = [
      'Total Revenue',
      'Active Users',
      'Conversion Rate',
      'Avg Order Value',
      'Churn Rate',
      'MRR',
    ];

    const App = function App() {
      return se(
        'div',
        null,
        se(
          'div',
          null,
          se(
            'div',
            {id: 'dashboard'},
            se(ClientNavbar, {
              user,
              cartCount: 0,
              categories: metrics.map((m, i) => ({
                name: m,
                slug: m.toLowerCase().replace(/ /g, '-'),
              })),
            }),
            se(
              'div',
              {className: 'metrics-row'},
              metrics.map((title, i) =>
                se(
                  Suspense,
                  {key: i, fallback: se('div', null, 'Loading...')},
                  se(ServerMetricCard, {
                    title,
                    fetchDelay: FETCH_DELAYS.cacheHit + (i % 3) * 2,
                  })
                )
              )
            ),
            se(
              'div',
              {className: 'dashboard-grid'},
              se(
                Suspense,
                {fallback: se('div', null, 'Loading chart...')},
                se(ServerAnalytics, {fetchDelay: FETCH_DELAYS.dbQuerySlow})
              ),
              se(
                Suspense,
                {fallback: se('div', null, 'Loading activity...')},
                se(ServerRecentActivity, {fetchDelay: FETCH_DELAYS.dbQuery})
              )
            )
          )
        )
      );
    };

    return {
      tree: se(App, null),
      name: 'dashboard',
      description:
        'Dashboard: 8 async fetches (1-11ms each), 8 Suspense boundaries, ' +
        'charts + data tables (client), 6 metric cards, 2 contexts',
      componentCount: 50,
    };
  }

  return [buildBlogScenario, buildEcommercePLPScenario, buildDashboardScenario];
}

module.exports = {createScenarios};
