'use strict';

/**
 * Realistic data generators for fused renderer benchmark scenarios.
 * Generates blog posts (~5-10KB each), products (~2-4KB each), and user objects.
 */

function generateBlogPost(id) {
  const paragraphs = Array.from(
    {length: 5 + (id % 4)},
    (_, i) =>
      `Paragraph ${i + 1} of post ${id}. ` +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(
        3 + (i % 3)
      ) +
      'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
      'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. '
  );
  return {
    id,
    title: `Understanding Advanced React Patterns Part ${id}: Server Components and Beyond`,
    slug: `understanding-advanced-react-patterns-part-${id}`,
    excerpt:
      'A deep dive into modern React architecture patterns including server components, streaming SSR, and selective hydration.',
    content: paragraphs.join('\n\n'),
    publishedAt: new Date(2026, 0, id).toISOString(),
    updatedAt: new Date(2026, 2, id).toISOString(),
    readingTime: 5 + (id % 10),
    tags: ['react', 'server-components', 'performance', 'architecture'].slice(
      0,
      2 + (id % 3)
    ),
    category: {
      id: id % 5,
      name: ['Engineering', 'Design', 'Product', 'DevOps', 'Security'][id % 5],
      slug: ['engineering', 'design', 'product', 'devops', 'security'][id % 5],
    },
    author: {
      id: id % 20,
      name: `Author ${id % 20}`,
      avatar: `/avatars/author-${id % 20}.jpg`,
      bio: 'Senior engineer specializing in React performance optimization and server-side rendering architectures.',
      social: {twitter: `@author${id % 20}`, github: `author${id % 20}`},
    },
    coverImage: {
      url: `/images/post-${id}-cover.jpg`,
      alt: `Cover image for post ${id}`,
      width: 1200,
      height: 630,
    },
    seo: {
      metaTitle: `Advanced React Patterns Part ${id} | Engineering Blog`,
      metaDescription:
        'Learn about server components, streaming SSR, and more.',
      ogImage: `/og/post-${id}.png`,
      canonicalUrl: `https://blog.example.com/posts/part-${id}`,
    },
  };
}

function generateProduct(id) {
  return {
    id,
    name: `Premium Widget ${id} — Professional Grade`,
    slug: `premium-widget-${id}`,
    description:
      'High-quality professional grade widget with advanced features. '.repeat(
        3
      ) + 'Built with precision engineering and tested for durability.',
    price: {
      amount: (19.99 + id * 10.5).toFixed(2),
      currency: 'USD',
      formatted: `$${(19.99 + id * 10.5).toFixed(2)}`,
      compareAt: (29.99 + id * 10.5).toFixed(2),
    },
    rating: {
      average: (3.5 + (id % 15) / 10).toFixed(1),
      count: 50 + id * 3,
      distribution: {5: 40, 4: 25, 3: 15, 2: 10, 1: 10},
    },
    inventory: {
      inStock: id % 7 !== 0,
      quantity: id % 7 === 0 ? 0 : 10 + (id % 100),
      warehouse: ['US-East', 'US-West', 'EU-Central'][id % 3],
    },
    images: Array.from({length: 3}, (_, i) => ({
      url: `/products/${id}/image-${i}.jpg`,
      alt: `Product ${id} view ${i + 1}`,
      width: 800,
      height: 800,
    })),
    categories: [
      {id: id % 10, name: `Category ${id % 10}`},
      {id: 10 + (id % 5), name: `Subcategory ${id % 5}`},
    ],
    seller: {
      id: id % 30,
      name: `Verified Seller ${id % 30}`,
      rating: (4.0 + (id % 10) / 10).toFixed(1),
      verified: id % 3 !== 0,
      responseTime: '< 24 hours',
    },
    shipping: {
      free: id % 4 === 0,
      estimatedDays: 3 + (id % 5),
      methods: ['Standard', 'Express', 'Overnight'].slice(0, 1 + (id % 3)),
    },
    attributes: Object.fromEntries(
      ['Color', 'Size', 'Material', 'Weight', 'Warranty'].map((attr, i) => [
        attr,
        `${attr} Value ${id % (i + 3)}`,
      ])
    ),
  };
}

function generateUser() {
  return {
    id: 42,
    name: 'Jane Developer',
    email: 'jane@example.com',
    avatar: '/avatars/jane.jpg',
    role: 'admin',
    preferences: {
      theme: 'dark',
      locale: 'en-US',
      timezone: 'America/New_York',
      notifications: {email: true, push: false, sms: false},
    },
    subscription: {plan: 'pro', expiresAt: '2027-01-01T00:00:00Z'},
  };
}

module.exports = {generateBlogPost, generateProduct, generateUser};
