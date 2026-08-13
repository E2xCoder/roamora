import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "prisma", "dev.db");
const adapter = new PrismaBetterSqlite3({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter });

const OVERPASS_API = "https://overpass-api.de/api/interpreter";
const WIKI_API = "https://en.wikivoyage.org/w/api.php";

const CITIES: { name: string; lat: number; lng: number; country: string }[] = [
  // ===== TURKEY =====
  { name: "Istanbul", lat: 41.0082, lng: 28.9784, country: "Turkey" },
  { name: "Cappadocia", lat: 38.6431, lng: 34.8289, country: "Turkey" },
  { name: "Antalya", lat: 36.8969, lng: 30.7133, country: "Turkey" },
  { name: "Bodrum", lat: 37.0344, lng: 27.4305, country: "Turkey" },
  { name: "Fethiye", lat: 36.6592, lng: 29.1264, country: "Turkey" },
  { name: "Izmir", lat: 38.4237, lng: 27.1428, country: "Turkey" },
  { name: "Ephesus", lat: 37.9394, lng: 27.3417, country: "Turkey" },
  { name: "Pamukkale", lat: 37.9204, lng: 29.1187, country: "Turkey" },
  { name: "Ankara", lat: 39.9334, lng: 32.8597, country: "Turkey" },
  { name: "Trabzon", lat: 41.0027, lng: 39.7168, country: "Turkey" },
  { name: "Kas", lat: 36.1993, lng: 29.6383, country: "Turkey" },
  { name: "Olympos", lat: 36.3956, lng: 30.4731, country: "Turkey" },
  { name: "Safranbolu", lat: 41.2536, lng: 32.6933, country: "Turkey" },
  { name: "Mardin", lat: 37.3212, lng: 40.7245, country: "Turkey" },
  { name: "Göreme", lat: 38.6432, lng: 34.8314, country: "Turkey" },
  { name: "Dalyan", lat: 36.8351, lng: 28.6414, country: "Turkey" },
  { name: "Ölüdeniz", lat: 36.5499, lng: 29.1144, country: "Turkey" },
  { name: "Alanya", lat: 36.5443, lng: 31.9994, country: "Turkey" },
  { name: "Bursa", lat: 40.1828, lng: 29.0665, country: "Turkey" },
  { name: "Konya", lat: 37.8746, lng: 32.4932, country: "Turkey" },
  { name: "Gaziantep", lat: 37.0662, lng: 37.3833, country: "Turkey" },
  { name: "Amasya", lat: 40.6499, lng: 35.8353, country: "Turkey" },
  { name: "Kaçkar Mountains", lat: 40.8367, lng: 41.1167, country: "Turkey" },
  { name: "Mount Ararat", lat: 39.7018, lng: 44.2983, country: "Turkey" },
  { name: "Sumela Monastery", lat: 40.6917, lng: 39.6556, country: "Turkey" },
  { name: "Ani", lat: 40.5064, lng: 43.5727, country: "Turkey" },

  // ===== ITALY =====
  { name: "Rome", lat: 41.9028, lng: 12.4964, country: "Italy" },
  { name: "Florence", lat: 43.7696, lng: 11.2558, country: "Italy" },
  { name: "Venice", lat: 45.4408, lng: 12.3155, country: "Italy" },
  { name: "Milan", lat: 45.4642, lng: 9.19, country: "Italy" },
  { name: "Naples", lat: 40.8518, lng: 14.2681, country: "Italy" },
  { name: "Cinque Terre", lat: 44.1461, lng: 9.6439, country: "Italy" },
  { name: "Amalfi", lat: 40.634, lng: 14.6027, country: "Italy" },
  { name: "Bologna", lat: 44.4949, lng: 11.3426, country: "Italy" },
  { name: "Verona", lat: 45.4384, lng: 10.9916, country: "Italy" },
  { name: "Turin", lat: 45.0703, lng: 7.6869, country: "Italy" },
  { name: "Siena", lat: 43.3188, lng: 11.3308, country: "Italy" },
  { name: "Pisa", lat: 43.7228, lng: 10.4017, country: "Italy" },
  { name: "Palermo", lat: 38.1157, lng: 13.3615, country: "Italy" },
  { name: "Catania", lat: 37.5079, lng: 15.083, country: "Italy" },
  { name: "Syracuse", lat: 37.0755, lng: 15.2866, country: "Italy" },
  { name: "Matera", lat: 40.6664, lng: 16.6043, country: "Italy" },
  { name: "Positano", lat: 40.628, lng: 14.485, country: "Italy" },
  { name: "Ravello", lat: 40.649, lng: 14.6116, country: "Italy" },
  { name: "Lake Como", lat: 46.0154, lng: 9.257, country: "Italy" },
  { name: "Lake Garda", lat: 45.6389, lng: 10.7115, country: "Italy" },
  { name: "Dolomites", lat: 46.4102, lng: 11.8440, country: "Italy" },
  { name: "Genoa", lat: 44.4056, lng: 8.9463, country: "Italy" },
  { name: "Lecce", lat: 40.3516, lng: 18.175, country: "Italy" },
  { name: "Sardinia Cagliari", lat: 39.2238, lng: 9.1217, country: "Italy" },
  { name: "Taormina", lat: 37.8516, lng: 15.2886, country: "Italy" },

  // ===== SPAIN =====
  { name: "Barcelona", lat: 41.3874, lng: 2.1686, country: "Spain" },
  { name: "Madrid", lat: 40.4168, lng: -3.7038, country: "Spain" },
  { name: "Seville", lat: 37.3891, lng: -5.9845, country: "Spain" },
  { name: "Granada", lat: 37.1773, lng: -3.5986, country: "Spain" },
  { name: "Valencia", lat: 39.4699, lng: -0.3763, country: "Spain" },
  { name: "Malaga", lat: 36.7213, lng: -4.4214, country: "Spain" },
  { name: "San Sebastian", lat: 43.3183, lng: -1.9812, country: "Spain" },
  { name: "Bilbao", lat: 43.263, lng: -2.935, country: "Spain" },
  { name: "Toledo", lat: 39.8628, lng: -4.0273, country: "Spain" },
  { name: "Cordoba", lat: 37.8882, lng: -4.7794, country: "Spain" },
  { name: "Ronda", lat: 36.7462, lng: -5.1615, country: "Spain" },
  { name: "Salamanca", lat: 40.9701, lng: -5.6635, country: "Spain" },
  { name: "Santiago de Compostela", lat: 42.8782, lng: -8.5448, country: "Spain" },
  { name: "Palma de Mallorca", lat: 39.5696, lng: 2.6502, country: "Spain" },
  { name: "Ibiza", lat: 38.9067, lng: 1.4206, country: "Spain" },
  { name: "Tenerife", lat: 28.2916, lng: -16.6291, country: "Spain" },
  { name: "Cadiz", lat: 36.5271, lng: -6.2886, country: "Spain" },
  { name: "Girona", lat: 41.9794, lng: 2.8214, country: "Spain" },
  { name: "Montserrat", lat: 41.5933, lng: 1.8376, country: "Spain" },

  // ===== FRANCE =====
  { name: "Paris", lat: 48.8566, lng: 2.3522, country: "France" },
  { name: "Nice", lat: 43.7102, lng: 7.262, country: "France" },
  { name: "Lyon", lat: 45.764, lng: 4.8357, country: "France" },
  { name: "Marseille", lat: 43.2965, lng: 5.3698, country: "France" },
  { name: "Bordeaux", lat: 44.8378, lng: -0.5792, country: "France" },
  { name: "Strasbourg", lat: 48.5734, lng: 7.7521, country: "France" },
  { name: "Colmar", lat: 48.0794, lng: 7.3558, country: "France" },
  { name: "Mont Saint-Michel", lat: 48.636, lng: -1.5115, country: "France" },
  { name: "Avignon", lat: 43.9493, lng: 4.8055, country: "France" },
  { name: "Toulouse", lat: 43.6047, lng: 1.4442, country: "France" },
  { name: "Carcassonne", lat: 43.2123, lng: 2.3536, country: "France" },
  { name: "Annecy", lat: 45.899, lng: 6.1294, country: "France" },
  { name: "Chamonix", lat: 45.9237, lng: 6.8694, country: "France" },
  { name: "Gordes", lat: 43.9116, lng: 5.2006, country: "France" },
  { name: "Saint-Tropez", lat: 43.2727, lng: 6.6406, country: "France" },
  { name: "Cannes", lat: 43.5528, lng: 7.0174, country: "France" },
  { name: "Dijon", lat: 47.322, lng: 5.0415, country: "France" },
  { name: "Nantes", lat: 47.2184, lng: -1.5536, country: "France" },
  { name: "Corsica Ajaccio", lat: 41.9192, lng: 8.7386, country: "France" },

  // ===== GERMANY =====
  { name: "Berlin", lat: 52.52, lng: 13.405, country: "Germany" },
  { name: "Munich", lat: 48.1351, lng: 11.582, country: "Germany" },
  { name: "Hamburg", lat: 53.5511, lng: 9.9937, country: "Germany" },
  { name: "Cologne", lat: 50.9375, lng: 6.9603, country: "Germany" },
  { name: "Frankfurt", lat: 50.1109, lng: 8.6821, country: "Germany" },
  { name: "Dresden", lat: 51.0504, lng: 13.7373, country: "Germany" },
  { name: "Heidelberg", lat: 49.3988, lng: 8.6724, country: "Germany" },
  { name: "Rothenburg ob der Tauber", lat: 49.3769, lng: 10.1789, country: "Germany" },
  { name: "Nuremberg", lat: 49.4521, lng: 11.0767, country: "Germany" },
  { name: "Freiburg", lat: 47.999, lng: 7.842, country: "Germany" },
  { name: "Stuttgart", lat: 48.7758, lng: 9.1829, country: "Germany" },
  { name: "Leipzig", lat: 51.3397, lng: 12.3731, country: "Germany" },
  { name: "Black Forest", lat: 48.2708, lng: 8.1679, country: "Germany" },
  { name: "Neuschwanstein", lat: 47.5576, lng: 10.7498, country: "Germany" },
  { name: "Saxon Switzerland", lat: 50.9128, lng: 14.0819, country: "Germany" },
  { name: "Bamberg", lat: 49.8988, lng: 10.8978, country: "Germany" },
  { name: "Lubeck", lat: 53.8655, lng: 10.6866, country: "Germany" },

  // ===== AUSTRIA =====
  { name: "Vienna", lat: 48.2082, lng: 16.3738, country: "Austria" },
  { name: "Salzburg", lat: 47.8095, lng: 13.055, country: "Austria" },
  { name: "Innsbruck", lat: 47.2692, lng: 11.4041, country: "Austria" },
  { name: "Hallstatt", lat: 47.5622, lng: 13.6493, country: "Austria" },
  { name: "Graz", lat: 47.0707, lng: 15.4395, country: "Austria" },
  { name: "Zell am See", lat: 47.3267, lng: 12.7955, country: "Austria" },
  { name: "Wachau Valley", lat: 48.3667, lng: 15.4167, country: "Austria" },

  // ===== SWITZERLAND =====
  { name: "Zurich", lat: 47.3769, lng: 8.5417, country: "Switzerland" },
  { name: "Interlaken", lat: 46.6863, lng: 7.8632, country: "Switzerland" },
  { name: "Lucerne", lat: 47.0505, lng: 8.3064, country: "Switzerland" },
  { name: "Bern", lat: 46.948, lng: 7.4474, country: "Switzerland" },
  { name: "Geneva", lat: 46.2044, lng: 6.1432, country: "Switzerland" },
  { name: "Zermatt", lat: 46.0207, lng: 7.7491, country: "Switzerland" },
  { name: "Grindelwald", lat: 46.6243, lng: 8.0414, country: "Switzerland" },
  { name: "Lauterbrunnen", lat: 46.5938, lng: 7.9084, country: "Switzerland" },
  { name: "St. Moritz", lat: 46.4908, lng: 9.8355, country: "Switzerland" },

  // ===== PORTUGAL =====
  { name: "Lisbon", lat: 38.7223, lng: -9.1393, country: "Portugal" },
  { name: "Porto", lat: 41.1579, lng: -8.6291, country: "Portugal" },
  { name: "Sintra", lat: 38.7983, lng: -9.3881, country: "Portugal" },
  { name: "Lagos", lat: 37.1028, lng: -8.6732, country: "Portugal" },
  { name: "Faro", lat: 37.0194, lng: -7.9322, country: "Portugal" },
  { name: "Madeira Funchal", lat: 32.6669, lng: -16.9241, country: "Portugal" },
  { name: "Azores Ponta Delgada", lat: 37.7483, lng: -25.6666, country: "Portugal" },
  { name: "Coimbra", lat: 40.2033, lng: -8.4103, country: "Portugal" },
  { name: "Evora", lat: 38.5711, lng: -7.9093, country: "Portugal" },

  // ===== GREECE =====
  { name: "Athens", lat: 37.9838, lng: 23.7275, country: "Greece" },
  { name: "Santorini", lat: 36.3932, lng: 25.4615, country: "Greece" },
  { name: "Mykonos", lat: 37.4467, lng: 25.3289, country: "Greece" },
  { name: "Crete Heraklion", lat: 35.3387, lng: 25.1442, country: "Greece" },
  { name: "Rhodes", lat: 36.4349, lng: 28.2176, country: "Greece" },
  { name: "Corfu", lat: 39.6243, lng: 19.9217, country: "Greece" },
  { name: "Meteora", lat: 39.7217, lng: 21.6306, country: "Greece" },
  { name: "Thessaloniki", lat: 40.6401, lng: 22.9444, country: "Greece" },
  { name: "Zakynthos", lat: 37.7875, lng: 20.8987, country: "Greece" },
  { name: "Nafplio", lat: 37.5675, lng: 22.8012, country: "Greece" },
  { name: "Delphi", lat: 38.4824, lng: 22.5012, country: "Greece" },
  { name: "Samaria Gorge", lat: 35.3025, lng: 23.9625, country: "Greece" },

  // ===== CROATIA =====
  { name: "Dubrovnik", lat: 42.6507, lng: 18.0944, country: "Croatia" },
  { name: "Split", lat: 43.5081, lng: 16.4402, country: "Croatia" },
  { name: "Zagreb", lat: 45.815, lng: 15.9819, country: "Croatia" },
  { name: "Plitvice Lakes", lat: 44.8654, lng: 15.582, country: "Croatia" },
  { name: "Hvar", lat: 43.1729, lng: 16.4411, country: "Croatia" },
  { name: "Rovinj", lat: 45.0812, lng: 13.6387, country: "Croatia" },
  { name: "Zadar", lat: 44.1194, lng: 15.2314, country: "Croatia" },
  { name: "Krka National Park", lat: 43.8014, lng: 15.9622, country: "Croatia" },

  // ===== CZECHIA =====
  { name: "Prague", lat: 50.0755, lng: 14.4378, country: "Czechia" },
  { name: "Cesky Krumlov", lat: 48.8127, lng: 14.3175, country: "Czechia" },
  { name: "Brno", lat: 49.1951, lng: 16.6068, country: "Czechia" },
  { name: "Karlovy Vary", lat: 50.2326, lng: 12.8713, country: "Czechia" },
  { name: "Bohemian Switzerland", lat: 50.8831, lng: 14.3725, country: "Czechia" },

  // ===== HUNGARY =====
  { name: "Budapest", lat: 47.4979, lng: 19.0402, country: "Hungary" },
  { name: "Eger", lat: 47.9025, lng: 20.3772, country: "Hungary" },
  { name: "Lake Balaton", lat: 46.8582, lng: 17.7286, country: "Hungary" },

  // ===== POLAND =====
  { name: "Krakow", lat: 50.0647, lng: 19.945, country: "Poland" },
  { name: "Warsaw", lat: 52.2297, lng: 21.0122, country: "Poland" },
  { name: "Gdansk", lat: 54.352, lng: 18.6466, country: "Poland" },
  { name: "Wroclaw", lat: 51.1079, lng: 17.0385, country: "Poland" },
  { name: "Zakopane", lat: 49.299, lng: 19.9496, country: "Poland" },
  { name: "Poznan", lat: 52.4064, lng: 16.9252, country: "Poland" },

  // ===== NETHERLANDS =====
  { name: "Amsterdam", lat: 52.3676, lng: 4.9041, country: "Netherlands" },
  { name: "Rotterdam", lat: 51.9244, lng: 4.4777, country: "Netherlands" },
  { name: "Utrecht", lat: 52.0907, lng: 5.1214, country: "Netherlands" },
  { name: "The Hague", lat: 52.0705, lng: 4.3007, country: "Netherlands" },
  { name: "Giethoorn", lat: 52.7398, lng: 6.0776, country: "Netherlands" },

  // ===== BELGIUM =====
  { name: "Brussels", lat: 50.8503, lng: 4.3517, country: "Belgium" },
  { name: "Bruges", lat: 51.2093, lng: 3.2247, country: "Belgium" },
  { name: "Ghent", lat: 51.0543, lng: 3.7174, country: "Belgium" },
  { name: "Antwerp", lat: 51.2194, lng: 4.4025, country: "Belgium" },
  { name: "Dinant", lat: 50.2607, lng: 4.9122, country: "Belgium" },

  // ===== SCANDINAVIA =====
  { name: "Copenhagen", lat: 55.6761, lng: 12.5683, country: "Denmark" },
  { name: "Stockholm", lat: 59.3293, lng: 18.0686, country: "Sweden" },
  { name: "Gothenburg", lat: 57.7089, lng: 11.9746, country: "Sweden" },
  { name: "Oslo", lat: 59.9139, lng: 10.7522, country: "Norway" },
  { name: "Bergen", lat: 60.3913, lng: 5.3221, country: "Norway" },
  { name: "Tromso", lat: 69.6496, lng: 18.9560, country: "Norway" },
  { name: "Lofoten", lat: 68.2092, lng: 14.5631, country: "Norway" },
  { name: "Geirangerfjord", lat: 62.1048, lng: 7.0949, country: "Norway" },
  { name: "Preikestolen", lat: 58.9863, lng: 6.1871, country: "Norway" },
  { name: "Flam", lat: 60.863, lng: 7.113, country: "Norway" },
  { name: "Helsinki", lat: 60.1699, lng: 24.9384, country: "Finland" },
  { name: "Rovaniemi", lat: 66.5039, lng: 25.7294, country: "Finland" },
  { name: "Reykjavik", lat: 64.1466, lng: -21.9426, country: "Iceland" },
  { name: "Vik", lat: 63.4186, lng: -19.0060, country: "Iceland" },
  { name: "Akureyri", lat: 65.6835, lng: -18.0878, country: "Iceland" },
  { name: "Golden Circle Iceland", lat: 64.3271, lng: -20.1199, country: "Iceland" },

  // ===== BALTICS =====
  { name: "Tallinn", lat: 59.437, lng: 24.7536, country: "Estonia" },
  { name: "Riga", lat: 56.9496, lng: 24.1052, country: "Latvia" },
  { name: "Vilnius", lat: 54.6872, lng: 25.2797, country: "Lithuania" },
  { name: "Trakai", lat: 54.6378, lng: 24.9345, country: "Lithuania" },

  // ===== BALKANS =====
  { name: "Ljubljana", lat: 46.0569, lng: 14.5058, country: "Slovenia" },
  { name: "Lake Bled", lat: 46.3683, lng: 14.1146, country: "Slovenia" },
  { name: "Piran", lat: 45.5283, lng: 13.5681, country: "Slovenia" },
  { name: "Kotor", lat: 42.4247, lng: 18.7712, country: "Montenegro" },
  { name: "Budva", lat: 42.2910, lng: 18.8394, country: "Montenegro" },
  { name: "Durmitor", lat: 43.1506, lng: 19.0328, country: "Montenegro" },
  { name: "Mostar", lat: 43.3438, lng: 17.8078, country: "Bosnia" },
  { name: "Sarajevo", lat: 43.8563, lng: 18.4131, country: "Bosnia" },
  { name: "Belgrade", lat: 44.7866, lng: 20.4489, country: "Serbia" },
  { name: "Novi Sad", lat: 45.2551, lng: 19.8451, country: "Serbia" },
  { name: "Ohrid", lat: 41.1231, lng: 20.8016, country: "North Macedonia" },
  { name: "Tirana", lat: 41.3275, lng: 19.8187, country: "Albania" },
  { name: "Berat", lat: 40.7058, lng: 19.9522, country: "Albania" },
  { name: "Gjirokaster", lat: 40.0758, lng: 20.1389, country: "Albania" },
  { name: "Ksamil", lat: 39.7711, lng: 20.0002, country: "Albania" },

  // ===== ROMANIA & BULGARIA =====
  { name: "Bucharest", lat: 44.4268, lng: 26.1025, country: "Romania" },
  { name: "Brasov", lat: 45.6427, lng: 25.5887, country: "Romania" },
  { name: "Sibiu", lat: 45.7983, lng: 24.1256, country: "Romania" },
  { name: "Cluj-Napoca", lat: 46.7712, lng: 23.6236, country: "Romania" },
  { name: "Sighisoara", lat: 46.2197, lng: 24.7917, country: "Romania" },
  { name: "Bran Castle", lat: 45.5151, lng: 25.3672, country: "Romania" },
  { name: "Transfagarasan", lat: 45.6033, lng: 24.6153, country: "Romania" },
  { name: "Sofia", lat: 42.6977, lng: 23.3219, country: "Bulgaria" },
  { name: "Plovdiv", lat: 42.1354, lng: 24.7453, country: "Bulgaria" },
  { name: "Veliko Tarnovo", lat: 43.0757, lng: 25.6172, country: "Bulgaria" },
  { name: "Rila Monastery", lat: 42.1336, lng: 23.3403, country: "Bulgaria" },

  // ===== UK & IRELAND =====
  { name: "London", lat: 51.5074, lng: -0.1278, country: "UK" },
  { name: "Edinburgh", lat: 55.9533, lng: -3.1883, country: "UK" },
  { name: "Bath", lat: 51.3758, lng: -2.3599, country: "UK" },
  { name: "Oxford", lat: 51.752, lng: -1.2577, country: "UK" },
  { name: "Cambridge", lat: 52.2053, lng: 0.1218, country: "UK" },
  { name: "York", lat: 53.961, lng: -1.0812, country: "UK" },
  { name: "Liverpool", lat: 53.4084, lng: -2.9916, country: "UK" },
  { name: "Lake District", lat: 54.4609, lng: -3.0886, country: "UK" },
  { name: "Cotswolds", lat: 51.8330, lng: -1.7833, country: "UK" },
  { name: "Scottish Highlands", lat: 57.1297, lng: -4.8997, country: "UK" },
  { name: "Isle of Skye", lat: 57.3084, lng: -6.3262, country: "UK" },
  { name: "Snowdonia", lat: 52.9186, lng: -3.8937, country: "UK" },
  { name: "Giants Causeway", lat: 55.2408, lng: -6.5116, country: "UK" },
  { name: "Dublin", lat: 53.3498, lng: -6.2603, country: "Ireland" },
  { name: "Galway", lat: 53.2707, lng: -9.0568, country: "Ireland" },
  { name: "Cliffs of Moher", lat: 52.9715, lng: -9.4309, country: "Ireland" },
  { name: "Ring of Kerry", lat: 51.7474, lng: -10.1095, country: "Ireland" },
  { name: "Killarney", lat: 52.0599, lng: -9.5044, country: "Ireland" },

  // ===== NORDIC NATURE & HIKING =====
  { name: "Faroe Islands", lat: 62.0107, lng: -6.7741, country: "Denmark" },
  { name: "Svalbard", lat: 78.2232, lng: 15.6267, country: "Norway" },
  { name: "Jotunheimen", lat: 61.6167, lng: 8.3, country: "Norway" },
  { name: "Hardangerfjord", lat: 60.4167, lng: 6.55, country: "Norway" },
  { name: "Abisko", lat: 68.3496, lng: 18.8309, country: "Sweden" },
  { name: "Kungsleden Trail", lat: 67.85, lng: 18.72, country: "Sweden" },

  // ===== LESSER-KNOWN GEMS =====
  { name: "Colosseum of Pula", lat: 44.8732, lng: 13.8497, country: "Croatia" },
  { name: "Rila Lakes", lat: 42.2006, lng: 23.3217, country: "Bulgaria" },
  { name: "Plitvice Lakes", lat: 44.8654, lng: 15.582, country: "Croatia" },
  { name: "Capri", lat: 40.5531, lng: 14.2223, country: "Italy" },
  { name: "Procida", lat: 40.7597, lng: 14.0208, country: "Italy" },
  { name: "Chefchaouen", lat: 35.1688, lng: -5.2636, country: "Morocco" },
  { name: "Valletta", lat: 35.8989, lng: 14.5146, country: "Malta" },
  { name: "Gozo", lat: 36.0444, lng: 14.2518, country: "Malta" },
  { name: "Luxembourg City", lat: 49.6116, lng: 6.1319, country: "Luxembourg" },
  { name: "Monaco", lat: 43.7384, lng: 7.4246, country: "Monaco" },
  { name: "Andorra la Vella", lat: 42.5063, lng: 1.5218, country: "Andorra" },
  { name: "San Marino", lat: 43.9424, lng: 12.4578, country: "San Marino" },
  { name: "Liechtenstein Vaduz", lat: 47.1410, lng: 9.5215, country: "Liechtenstein" },
  { name: "Cyprus Paphos", lat: 34.7572, lng: 32.4218, country: "Cyprus" },
  { name: "Cyprus Limassol", lat: 34.6786, lng: 33.0413, country: "Cyprus" },
];

function categorize(tags: Record<string, string>): string {
  if (tags.tourism === "viewpoint") return "viewpoint";
  if (tags.tourism === "museum" || tags.tourism === "gallery") return "museum";
  if (tags.historic) return "historic";
  if (tags.natural === "beach" || tags.leisure === "beach_resort") return "beach";
  if (tags.natural) return "nature";
  if (tags.tourism === "attraction") return "attraction";
  if (tags.amenity === "restaurant") return "restaurant";
  if (tags.amenity === "cafe") return "cafe";
  if (tags.amenity === "bar" || tags.amenity === "pub") return "nightlife";
  if (tags.leisure === "park" || tags.leisure === "garden") return "nature";
  if (tags.tourism) return "attraction";
  return "other";
}

function isHiddenGem(tags: Record<string, string>): boolean {
  if (tags.tourism === "viewpoint") return true;
  if (tags.historic && !["monument", "memorial"].includes(tags.historic)) return true;
  if (tags.natural && ["waterfall", "cave_entrance", "peak", "hot_spring", "spring", "arch"].includes(tags.natural))
    return true;
  return false;
}

async function fetchOverpassPOIs(lat: number, lng: number, radius: number = 8000) {
  const q = `[out:json][timeout:30];
(
  node["tourism"="attraction"]["name"](around:${radius},${lat},${lng});
  node["tourism"="viewpoint"]["name"](around:${radius},${lat},${lng});
  node["tourism"="museum"]["name"](around:${radius},${lat},${lng});
  node["tourism"="gallery"]["name"](around:${radius},${lat},${lng});
  node["historic"]["name"](around:${radius},${lat},${lng});
  node["natural"~"waterfall|cave_entrance|peak|hot_spring|spring|beach|arch"]["name"](around:${radius},${lat},${lng});
  node["leisure"="park"]["name"](around:${radius},${lat},${lng});
  node["amenity"="restaurant"]["name"]["cuisine"](around:${radius},${lat},${lng});
  node["amenity"="cafe"]["name"](around:${radius},${lat},${lng});
);
out body;`;

  const res = await fetch(OVERPASS_API, {
    method: "POST",
    body: `data=${encodeURIComponent(q)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (!res.ok) {
    console.error(`  Overpass error ${res.status} for ${lat},${lng}`);
    return [];
  }

  const data = await res.json();
  return data.elements as Array<{
    id: number;
    lat: number;
    lon: number;
    tags: Record<string, string>;
  }>;
}

async function fetchWikivoyageListings(cityName: string) {
  const searchParams = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: cityName,
    srnamespace: "0",
    srlimit: "1",
    format: "json",
    origin: "*",
  });

  try {
    const searchRes = await fetch(`${WIKI_API}?${searchParams}`);
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json();
    const results = searchData.query?.search;
    if (!results || results.length === 0) return [];

    const pageTitle = results[0].title;

    const contentParams = new URLSearchParams({
      action: "parse",
      page: pageTitle,
      prop: "wikitext",
      format: "json",
      origin: "*",
    });
    const contentRes = await fetch(`${WIKI_API}?${contentParams}`);
    if (!contentRes.ok) return [];
    const contentData = await contentRes.json();
    const wikitext: string = contentData.parse?.wikitext?.["*"] || "";

    const listingRegex =
      /\{\{(?:listing|see|do|eat|drink|sleep|buy)\s*\|([^}]+)\}\}/gi;
    const listings: Array<{
      name: string;
      lat?: number;
      lng?: number;
      address?: string;
      description?: string;
      type: string;
    }> = [];

    let match;
    while ((match = listingRegex.exec(wikitext)) !== null) {
      const params = match[1];
      const getParam = (key: string) => {
        const m = params.match(new RegExp(`${key}\\s*=\\s*([^|]+)`));
        return m ? m[1].trim() : undefined;
      };
      const name = getParam("name");
      if (!name) continue;
      const latStr = getParam("lat");
      const lngStr = getParam("long");
      if (!latStr || !lngStr) continue;

      listings.push({
        name,
        lat: parseFloat(latStr),
        lng: parseFloat(lngStr),
        address: getParam("address"),
        description: getParam("content") || getParam("description"),
        type: match[0].match(/\{\{(\w+)/)?.[1] || "listing",
      });
    }

    return listings;
  } catch {
    return [];
  }
}

function wikiTypeToCategory(type: string): string {
  switch (type.toLowerCase()) {
    case "see":
      return "attraction";
    case "do":
      return "attraction";
    case "eat":
      return "restaurant";
    case "drink":
      return "cafe";
    case "sleep":
      return "accommodation";
    case "buy":
      return "shopping";
    default:
      return "other";
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`\n=== Roamora Data Seeder ===`);
  console.log(`${CITIES.length} cities to process\n`);

  const existingCount = await prisma.place.count();
  console.log(`Current places in DB: ${existingCount}\n`);

  let totalAdded = 0;
  let totalSkipped = 0;

  for (let i = 0; i < CITIES.length; i++) {
    const city = CITIES[i];
    console.log(`[${i + 1}/${CITIES.length}] ${city.name}, ${city.country}`);

    // Fetch from Overpass
    let overpassPlaces: Array<{
      id: number;
      lat: number;
      lon: number;
      tags: Record<string, string>;
    }> = [];

    try {
      overpassPlaces = await fetchOverpassPOIs(city.lat, city.lng);
      console.log(`  Overpass: ${overpassPlaces.length} POIs found`);
    } catch (err) {
      console.error(`  Overpass failed:`, err);
    }

    await sleep(1500);

    // Fetch from Wikivoyage
    let wikiListings: Array<{
      name: string;
      lat?: number;
      lng?: number;
      address?: string;
      description?: string;
      type: string;
    }> = [];

    try {
      wikiListings = await fetchWikivoyageListings(city.name);
      console.log(`  Wikivoyage: ${wikiListings.length} listings found`);
    } catch (err) {
      console.error(`  Wikivoyage failed:`, err);
    }

    await sleep(500);

    // Deduplicate by name (case-insensitive)
    const seenNames = new Set<string>();
    const placesToAdd: Array<{
      name: string;
      lat: number;
      lng: number;
      category: string;
      tags: string;
      notes: string;
      source: string;
      address?: string;
      isHiddenGem: boolean;
    }> = [];

    for (const el of overpassPlaces) {
      const name = el.tags.name;
      if (!name || seenNames.has(name.toLowerCase())) continue;
      seenNames.add(name.toLowerCase());

      const cat = categorize(el.tags);
      const tagsArr = [city.name, city.country];
      if (el.tags.cuisine) tagsArr.push(el.tags.cuisine);
      if (el.tags.historic) tagsArr.push(el.tags.historic);

      placesToAdd.push({
        name,
        lat: el.lat,
        lng: el.lon,
        category: cat,
        tags: JSON.stringify(tagsArr),
        notes: el.tags.description || el.tags["description:en"] || "",
        source: "overpass",
        address: el.tags["addr:street"]
          ? `${el.tags["addr:street"]} ${el.tags["addr:housenumber"] || ""}, ${city.name}`.trim()
          : undefined,
        isHiddenGem: isHiddenGem(el.tags),
      });
    }

    for (const listing of wikiListings) {
      if (!listing.lat || !listing.lng) continue;
      if (seenNames.has(listing.name.toLowerCase())) continue;
      seenNames.add(listing.name.toLowerCase());

      placesToAdd.push({
        name: listing.name,
        lat: listing.lat,
        lng: listing.lng,
        category: wikiTypeToCategory(listing.type),
        tags: JSON.stringify([city.name, city.country, "wikivoyage"]),
        notes: listing.description || "",
        source: "wikivoyage",
        address: listing.address,
        isHiddenGem: false,
      });
    }

    if (placesToAdd.length > 0) {
      // Check for existing places to avoid duplicates across runs
      const existingPlaces = await prisma.place.findMany({
        where: {
          source: { in: ["overpass", "wikivoyage"] },
        },
        select: { name: true, lat: true, lng: true },
      });

      const existingSet = new Set(
        existingPlaces.map((p) => `${p.name.toLowerCase()}|${p.lat.toFixed(4)}|${p.lng.toFixed(4)}`)
      );

      const newPlaces = placesToAdd.filter(
        (p) => !existingSet.has(`${p.name.toLowerCase()}|${p.lat.toFixed(4)}|${p.lng.toFixed(4)}`)
      );

      if (newPlaces.length > 0) {
        await prisma.place.createMany({ data: newPlaces });
        totalAdded += newPlaces.length;
        console.log(`  Added ${newPlaces.length} new places (${placesToAdd.length - newPlaces.length} duplicates skipped)`);
      } else {
        totalSkipped += placesToAdd.length;
        console.log(`  All ${placesToAdd.length} places already exist`);
      }
    } else {
      console.log(`  No places to add`);
    }

    // Rate limit between cities
    if (i < CITIES.length - 1) {
      await sleep(2000);
    }
  }

  const finalCount = await prisma.place.count();
  console.log(`\n=== Done ===`);
  console.log(`Added: ${totalAdded} places`);
  console.log(`Skipped: ${totalSkipped} duplicates`);
  console.log(`Total in DB: ${finalCount}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
