'use strict';

/**
 * Test scenarios for the fused renderer benchmark.
 * Each builder function returns {tree, name, description, componentCount}.
 *
 * Requires ServerReact, React, and clientExports to be injected.
 */

function createServerComponent(name, childrenFn) {
  const Component = function (props) {
    return childrenFn(props);
  };
  Object.defineProperty(Component, 'name', {value: name});
  return Component;
}

function generateProductData(count) {
  const products = [];
  for (let i = 0; i < count; i++) {
    products.push({
      id: i,
      name: `Product ${i}`,
      description: `Description for product ${i}. This is a realistic description with enough text to represent a real product listing that would appear in an e-commerce application.`,
      price: (Math.random() * 1000).toFixed(2),
      rating: (Math.random() * 5).toFixed(1),
      reviews: Math.floor(Math.random() * 500),
      inStock: Math.random() > 0.2,
      categories: ['Category A', 'Category B', 'Category C'].slice(
        0,
        Math.floor(Math.random() * 3) + 1
      ),
      seller: {
        name: `Seller ${i % 50}`,
        rating: (Math.random() * 5).toFixed(1),
        verified: Math.random() > 0.3,
      },
    });
  }
  return products;
}

function createScenarios(ServerReact, React, clientExports) {
  const se = ServerReact.createElement;
  const ce = React.createElement;

  function createClientComponent(name, renderFn) {
    return clientExports(renderFn);
  }

  function buildSmallTree() {
    const ClientButton = createClientComponent(
      'ClientButton',
      function ClientButton({label}) {
        return ce('button', null, label);
      }
    );

    const ServerHeader = createServerComponent('ServerHeader', () =>
      se(
        'header',
        null,
        se('h1', null, 'Small App'),
        se('nav', null, se('a', {href: '/'}, 'Home'))
      )
    );

    const ServerContent = createServerComponent('ServerContent', () =>
      se(
        'main',
        null,
        se('p', null, 'Hello from server component'),
        se(ClientButton, {label: 'Click me'}),
        se('p', null, 'More server content')
      )
    );

    const ServerFooter = createServerComponent('ServerFooter', () =>
      se('footer', null, se('p', null, '© 2026'))
    );

    const App = createServerComponent('App', () =>
      se(
        'div',
        {id: 'app'},
        se(ServerHeader, null),
        se(ServerContent, null),
        se(ServerFooter, null)
      )
    );

    return {
      tree: se(App, null),
      name: 'small',
      description: '10 components, minimal props, mostly server',
      componentCount: 10,
    };
  }

  function buildMediumTree() {
    const ClientProductCard = createClientComponent(
      'ClientProductCard',
      function ClientProductCard({product}) {
        return ce(
          'div',
          {className: 'product-card'},
          ce('h3', null, product.name),
          ce('p', null, product.description),
          ce('span', {className: 'price'}, '$' + product.price),
          ce('button', null, 'Add to cart')
        );
      }
    );

    const ClientSearchBar = createClientComponent(
      'ClientSearchBar',
      function ClientSearchBar({placeholder}) {
        return ce('input', {type: 'text', placeholder});
      }
    );

    const products = generateProductData(30);

    const ServerProductList = createServerComponent(
      'ServerProductList',
      ({products}) =>
        se(
          'div',
          {className: 'product-list'},
          products.map((product, i) => se(ClientProductCard, {key: i, product}))
        )
    );

    const ServerSidebar = createServerComponent('ServerSidebar', () =>
      se(
        'aside',
        null,
        se('h2', null, 'Categories'),
        ...['Electronics', 'Books', 'Clothing', 'Home', 'Sports'].map(cat =>
          se(
            'div',
            {key: cat, className: 'category'},
            se('a', {href: '#'}, cat)
          )
        )
      )
    );

    const ServerHeader = createServerComponent('ServerHeader', () =>
      se(
        'header',
        null,
        se('h1', null, 'Medium E-Commerce App'),
        se(ClientSearchBar, {placeholder: 'Search products...'}),
        se(
          'nav',
          null,
          ...['Home', 'Products', 'About', 'Contact'].map(item =>
            se('a', {key: item, href: '#'}, item)
          )
        )
      )
    );

    const App = createServerComponent('App', () =>
      se(
        'div',
        {id: 'app'},
        se(ServerHeader, null),
        se(
          'div',
          {className: 'layout'},
          se(ServerSidebar, null),
          se(ServerProductList, {products})
        ),
        se('footer', null, se('p', null, '© 2026'))
      )
    );

    return {
      tree: se(App, null),
      name: 'medium',
      description:
        '~100 components, 30 product cards with moderate props, mixed server/client',
      componentCount: 100,
    };
  }

  function buildLargeTree() {
    const ClientProductCard = createClientComponent(
      'ClientProductCardLarge',
      function ClientProductCard({product}) {
        return ce(
          'div',
          {className: 'product-card'},
          ce('h3', null, product.name),
          ce('p', null, product.description),
          ce('span', {className: 'price'}, '$' + product.price),
          ce('div', {className: 'rating'}, '★ ' + product.rating),
          ce('div', {className: 'reviews'}, product.reviews + ' reviews'),
          ce('button', null, 'Add to cart')
        );
      }
    );

    const ClientFilterPanel = createClientComponent(
      'ClientFilterPanel',
      function ClientFilterPanel({filters}) {
        return ce(
          'div',
          {className: 'filters'},
          filters.map((f, i) =>
            ce('label', {key: i}, ce('input', {type: 'checkbox'}), ' ', f)
          )
        );
      }
    );

    const ClientPagination = createClientComponent(
      'ClientPagination',
      function ClientPagination({page, total}) {
        return ce(
          'nav',
          {className: 'pagination'},
          ce('button', null, 'Prev'),
          ce('span', null, `Page ${page} of ${total}`),
          ce('button', null, 'Next')
        );
      }
    );

    const products = generateProductData(226);

    const ServerProductGrid = createServerComponent(
      'ServerProductGrid',
      ({products, page}) =>
        se(
          'div',
          {className: 'product-grid'},
          se('h2', null, `Showing ${products.length} products`),
          ...products.map((product, i) =>
            se(
              'div',
              {key: i, className: 'grid-cell'},
              se(ClientProductCard, {product})
            )
          ),
          se(ClientPagination, {page, total: 10})
        )
    );

    const ServerBreadcrumbs = createServerComponent(
      'ServerBreadcrumbs',
      ({path}) =>
        se(
          'nav',
          {className: 'breadcrumbs'},
          path.map((item, i) =>
            se('span', {key: i}, i > 0 ? ' > ' : '', se('a', {href: '#'}, item))
          )
        )
    );

    const ServerDeepWrapper = createServerComponent(
      'ServerDeepWrapper',
      ({depth, children}) => {
        if (depth <= 0) return children;
        return se(
          'div',
          {className: `depth-${depth}`},
          se(ServerDeepWrapper, {depth: depth - 1, children})
        );
      }
    );

    const filters = [
      'Under $25',
      '$25-$50',
      '$50-$100',
      '$100-$500',
      '$500+',
      'In Stock',
      'Free Shipping',
      'Top Rated',
      '4+ Stars',
      'On Sale',
    ];

    const App = createServerComponent('App', () =>
      se(
        'div',
        {id: 'app'},
        se(
          'header',
          null,
          se('h1', null, 'Large E-Commerce App'),
          se(ClientFilterPanel, {filters})
        ),
        se(ServerBreadcrumbs, {
          path: ['Home', 'Electronics', 'Laptops', 'Gaming Laptops'],
        }),
        se(ServerDeepWrapper, {
          depth: 10,
          children: se(ServerProductGrid, {products, page: 1}),
        }),
        se(
          'footer',
          null,
          se(
            'div',
            {className: 'footer-links'},
            ...['About', 'Privacy', 'Terms', 'Help', 'Contact'].map(item =>
              se('a', {key: item, href: '#'}, item)
            )
          )
        )
      )
    );

    return {
      tree: se(App, null),
      name: 'large',
      description:
        '1000+ components, 226 products with heavy props, deep nesting + wide grid',
      componentCount: 1000,
    };
  }

  function buildDeepTree() {
    const ClientLeaf = createClientComponent(
      'ClientLeaf',
      function ClientLeaf({depth, data}) {
        return ce('div', null, `Leaf at depth ${depth}: ${data}`);
      }
    );

    function buildDeepChain(depth, maxDepth) {
      if (depth >= maxDepth) {
        return se(ClientLeaf, {depth, data: 'bottom'});
      }
      const Wrapper = createServerComponent(`Wrapper${depth}`, ({children}) =>
        se('div', {className: `level-${depth}`}, children)
      );
      return se(Wrapper, null, buildDeepChain(depth + 1, maxDepth));
    }

    return {
      tree: buildDeepChain(0, 100),
      name: 'deep',
      description:
        '100-level deep nesting, server components wrapping a client leaf',
      componentCount: 101,
    };
  }

  function buildWideTree() {
    const ClientItem = createClientComponent(
      'ClientItem',
      function ClientItem({idx, text}) {
        return ce('li', null, `${idx}: ${text}`);
      }
    );

    const items = Array.from({length: 500}, (_, i) => ({
      idx: i,
      text: `Item ${i} content`,
    }));

    const ServerList = createServerComponent('ServerList', ({items}) =>
      se(
        'ul',
        null,
        items.map((item, i) =>
          i % 5 === 0
            ? se(ClientItem, {key: i, idx: item.idx, text: item.text})
            : se('li', {key: i}, `${item.idx}: ${item.text}`)
        )
      )
    );

    return {
      tree: se(ServerList, {items}),
      name: 'wide',
      description: '500 siblings, 20% client components, 80% server-rendered',
      componentCount: 501,
    };
  }

  function buildServerOnlyTree() {
    const products = generateProductData(100);

    const ServerProductCard = createServerComponent(
      'ServerProductCard',
      ({product}) =>
        se(
          'div',
          {className: 'product-card'},
          se('h3', null, product.name),
          se('p', null, product.description),
          se('span', {className: 'price'}, '$' + product.price),
          se('div', {className: 'rating'}, '★ ' + product.rating)
        )
    );

    const ServerGrid = createServerComponent('ServerGrid', ({products}) =>
      se(
        'div',
        {className: 'grid'},
        products.map((p, i) => se(ServerProductCard, {key: i, product: p}))
      )
    );

    const App = createServerComponent('App', () =>
      se(
        'div',
        null,
        se('h1', null, 'Server Only App'),
        se(ServerGrid, {products})
      )
    );

    return {
      tree: se(App, null),
      name: 'server-only',
      description:
        '100% server components, no client boundaries. Baseline for pure Fizz comparison.',
      componentCount: 102,
    };
  }

  return [
    buildSmallTree,
    buildMediumTree,
    buildLargeTree,
    buildDeepTree,
    buildWideTree,
    buildServerOnlyTree,
  ];
}

module.exports = {createScenarios};
