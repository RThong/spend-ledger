import { aeon } from "./aeon";
import { amex } from "./amex";
import { paypay } from "./paypay";
import { rakuten } from "./rakuten";
import { smbc } from "./smbc";
import type { Card } from "./util";

export const cards: Record<string, Card> = { rakuten, smbc, amex, aeon, paypay };
