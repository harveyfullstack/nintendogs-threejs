import type { AccessoryKind, CollectibleKind, FoodKind, ItemKind, ToyKind } from '../world/types';

export type ItemCategory = 'food' | 'drink' | 'toy' | 'care' | 'accessory' | 'room';

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  price: number;
  desc: string;
  /** consumed when used */
  consumable: boolean;
  /** prop to show in menus / hand */
  prop?: { item?: ItemKind; toy?: ToyKind; accessory?: AccessoryKind };
  food?: FoodKind;
  /** hunger restored (0..100) */
  nourish?: number;
  /** thirst restored */
  quench?: number;
  /** extra happiness */
  treat?: number;
}

export const ITEMS: ItemDef[] = [
  { id: 'dryFood', name: 'Dog Food', category: 'food', price: 10, desc: 'Basic dry kibble. Fills one bowl.', consumable: true, prop: { item: 'dryFood' }, food: 'dry', nourish: 60 },
  { id: 'cannedFood', name: 'Canned Food', category: 'food', price: 20, desc: 'Meaty and delicious. Dogs love it.', consumable: true, prop: { item: 'cannedFood' }, food: 'canned', nourish: 70, treat: 8 },
  { id: 'premiumFood', name: 'Premium Food', category: 'food', price: 40, desc: 'Top quality nutrition for a glossy coat.', consumable: true, prop: { item: 'premiumFood' }, food: 'premium', nourish: 85, treat: 15 },
  { id: 'jerky', name: 'Beef Jerky', category: 'food', price: 8, desc: 'A chewy treat. Great for rewarding tricks.', consumable: true, prop: { item: 'jerky' }, food: 'jerky', nourish: 15, treat: 20 },
  { id: 'milk', name: 'Milk', category: 'drink', price: 6, desc: 'A little treat of puppy milk.', consumable: true, prop: { item: 'milk' }, food: 'milk', quench: 50, nourish: 10, treat: 10 },
  { id: 'waterBottle', name: 'Water', category: 'drink', price: 0, desc: 'Fresh water. Always keep the bowl full.', consumable: false, prop: { item: 'waterBottle' }, quench: 100 },
  { id: 'tennisBall', name: 'Tennis Ball', category: 'toy', price: 15, desc: 'Throw it and your pup will chase it.', consumable: false, prop: { toy: 'tennisBall' } },
  { id: 'rubberBall', name: 'Rubber Ball', category: 'toy', price: 20, desc: 'Super bouncy!', consumable: false, prop: { toy: 'rubberBall' } },
  { id: 'frisbee', name: 'Flying Disc', category: 'toy', price: 30, desc: 'Needed for Disc Competitions. Flick to throw.', consumable: false, prop: { toy: 'frisbee' } },
  { id: 'goldDisc', name: 'Gold Disc', category: 'toy', price: 800, desc: 'A pro competition disc. Flies further.', consumable: false, prop: { toy: 'goldDisc' } },
  { id: 'rope', name: 'Tug Rope', category: 'toy', price: 25, desc: 'Play tug-of-war!', consumable: false, prop: { toy: 'rope' } },
  { id: 'squeaky', name: 'Squeaky Duck', category: 'toy', price: 18, desc: 'Squeak! Squeak!', consumable: false, prop: { toy: 'squeaky' } },
  { id: 'plushie', name: 'Teddy Bear', category: 'toy', price: 35, desc: 'A cuddly friend for your pup.', consumable: false, prop: { toy: 'plushie' } },
  { id: 'bone', name: 'Chew Bone', category: 'toy', price: 12, desc: 'Keeps puppies busy for ages.', consumable: false, prop: { toy: 'bone' } },
  { id: 'brush', name: 'Brush', category: 'care', price: 0, desc: 'Brush your pup to keep its coat shiny.', consumable: false, prop: { item: 'brush' } },
  { id: 'shampoo', name: 'Shampoo', category: 'care', price: 25, desc: 'Give your pup a bath. Good for 3 baths.', consumable: true, prop: { item: 'shampoo' } },
  { id: 'collarRed', name: 'Red Collar', category: 'accessory', price: 30, desc: 'A classic leather collar.', consumable: false, prop: { accessory: 'collarRed' } },
  { id: 'collarBlue', name: 'Blue Collar', category: 'accessory', price: 30, desc: 'A smart blue collar.', consumable: false, prop: { accessory: 'collarBlue' } },
  { id: 'bandana', name: 'Bandana', category: 'accessory', price: 45, desc: 'A jaunty neckerchief.', consumable: false, prop: { accessory: 'bandana' } },
  { id: 'ribbon', name: 'Ribbon', category: 'accessory', price: 40, desc: 'A pretty bow for the head.', consumable: false, prop: { accessory: 'ribbon' } },
  { id: 'bowtie', name: 'Bow Tie', category: 'accessory', price: 50, desc: 'For the dapper pup.', consumable: false, prop: { accessory: 'bowtie' } },
  { id: 'cap', name: 'Baseball Cap', category: 'accessory', price: 60, desc: 'Sporty!', consumable: false, prop: { accessory: 'cap' } },
  { id: 'sunglasses', name: 'Sunglasses', category: 'accessory', price: 80, desc: 'Too cool.', consumable: false, prop: { accessory: 'sunglasses' } },
  { id: 'flowerCrown', name: 'Flower Crown', category: 'accessory', price: 70, desc: 'Fresh from the meadow.', consumable: false, prop: { accessory: 'flowerCrown' } },
];

export function getItem(id: string): ItemDef | undefined {
  return ITEMS.find((i) => i.id === id);
}

export interface CollectibleDef { id: CollectibleKind; name: string; value: number; rarity: number }

export const COLLECTIBLES: CollectibleDef[] = [
  { id: 'emptyCan', name: 'Empty Can', value: 5, rarity: 1 },
  { id: 'oldBoot', name: 'Old Boot', value: 12, rarity: 1 },
  { id: 'feather', name: 'Feather', value: 15, rarity: 1 },
  { id: 'flower', name: 'Flower', value: 20, rarity: 1 },
  { id: 'seashell', name: 'Seashell', value: 40, rarity: 0.7 },
  { id: 'marble', name: 'Marble', value: 35, rarity: 0.7 },
  { id: 'toyCar', name: 'Toy Car', value: 60, rarity: 0.5 },
  { id: 'glasses', name: 'Glasses', value: 80, rarity: 0.4 },
  { id: 'pocketWatch', name: 'Pocket Watch', value: 150, rarity: 0.25 },
  { id: 'trophy', name: 'Trophy', value: 200, rarity: 0.2 },
  { id: 'gem', name: 'Gem', value: 400, rarity: 0.1 },
  { id: 'goldNugget', name: 'Gold Nugget', value: 600, rarity: 0.06 },
];

export function randomCollectible(): CollectibleDef {
  const total = COLLECTIBLES.reduce((s, c) => s + c.rarity, 0);
  let r = Math.random() * total;
  for (const c of COLLECTIBLES) {
    r -= c.rarity;
    if (r <= 0) return c;
  }
  return COLLECTIBLES[0];
}
