const { getUncachableStripeClient } = require('./stripeClient');

async function createProducts() {
    const stripe = await getUncachableStripeClient();
    
    console.log('Creating Scout-Faire products in Stripe...\n');

    // 1. Single Analysis - $2.99
    const singleProduct = await stripe.products.create({
        name: 'Single Analysis',
        description: 'One-time niche market analysis',
        metadata: { type: 'one_time', searches: '1' }
    });
    const singlePrice = await stripe.prices.create({
        product: singleProduct.id,
        unit_amount: 299,
        currency: 'usd',
    });
    console.log('Created: Single Analysis - $2.99');
    console.log(`  Product ID: ${singleProduct.id}`);
    console.log(`  Price ID: ${singlePrice.id}\n`);

    // 2. Starter Pack - 5 for $10
    const starterProduct = await stripe.products.create({
        name: 'Starter Pack',
        description: '5 niche market analyses',
        metadata: { type: 'one_time', searches: '5' }
    });
    const starterPrice = await stripe.prices.create({
        product: starterProduct.id,
        unit_amount: 1000,
        currency: 'usd',
    });
    console.log('Created: Starter Pack - $10 (5 searches)');
    console.log(`  Product ID: ${starterProduct.id}`);
    console.log(`  Price ID: ${starterPrice.id}\n`);

    // 3. Pro Monthly - $19.99/month (30 searches + $0.99 each additional)
    const proProduct = await stripe.products.create({
        name: 'Pro Monthly',
        description: '30 searches per month, $0.99 per additional search',
        metadata: { type: 'subscription', searches: '30', overage_price: '99' }
    });
    const proPrice = await stripe.prices.create({
        product: proProduct.id,
        unit_amount: 1999,
        currency: 'usd',
        recurring: { interval: 'month' }
    });
    console.log('Created: Pro Monthly - $19.99/month (30 searches)');
    console.log(`  Product ID: ${proProduct.id}`);
    console.log(`  Price ID: ${proPrice.id}\n`);

    // 4. Additional Search - $0.99 (for Pro tier overage)
    const overageProduct = await stripe.products.create({
        name: 'Additional Search',
        description: 'One additional search for Pro members',
        metadata: { type: 'overage' }
    });
    const overagePrice = await stripe.prices.create({
        product: overageProduct.id,
        unit_amount: 99,
        currency: 'usd',
    });
    console.log('Created: Additional Search - $0.99');
    console.log(`  Product ID: ${overageProduct.id}`);
    console.log(`  Price ID: ${overagePrice.id}\n`);

    // 5. Seikuku Precision - $34.99/month (unlimited)
    const seikukuProduct = await stripe.products.create({
        name: 'Seikuku Precision',
        description: 'Unlimited monthly searches - Premium tier',
        metadata: { type: 'subscription', searches: 'unlimited' }
    });
    const seikukuPrice = await stripe.prices.create({
        product: seikukuProduct.id,
        unit_amount: 3499,
        currency: 'usd',
        recurring: { interval: 'month' }
    });
    console.log('Created: Seikuku Precision - $34.99/month (unlimited)');
    console.log(`  Product ID: ${seikukuProduct.id}`);
    console.log(`  Price ID: ${seikukuPrice.id}\n`);

    console.log('\n=== SAVE THESE PRICE IDs ===');
    console.log(`SINGLE_PRICE_ID=${singlePrice.id}`);
    console.log(`STARTER_PRICE_ID=${starterPrice.id}`);
    console.log(`PRO_PRICE_ID=${proPrice.id}`);
    console.log(`OVERAGE_PRICE_ID=${overagePrice.id}`);
    console.log(`SEIKUKU_PRICE_ID=${seikukuPrice.id}`);
}

createProducts().catch(console.error);
