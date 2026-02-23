/*************************************************
   EcoSentinel – AI Powered Micro-Environment Node
   Team: SentinelX
**************************************************/

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "DHT.h"

/* ------------ OLED CONFIG ------------ */
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_ADDR 0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

/* ------------ PIN CONFIG ------------ */
#define DHTPIN     4
#define DHTTYPE    DHT11
#define GAS_PIN    34
#define SOIL_PIN   35
#define BUZZER_PIN 27

DHT dht(DHTPIN, DHTTYPE);

/* ------------ THRESHOLDS ------------ */
#define TEMP_MIN   20
#define TEMP_MAX   35
#define HUM_MIN    40
#define HUM_MAX    70
#define GAS_LIMIT  2000
#define MOIST_MIN  30
#define MOIST_MAX  70

unsigned long lastSwitch = 0;
bool showMainPage = true;

/* ------------ FUNCTION DECLARATIONS ------------ */
int getSoilPercent(int raw);
int calculateHealthScore(float t, float h, int gas, int moist);
String getStatus(int score);
void displayMain(float t, float h, int gas, int moist, String status);
void displayInfo(int score, String status);

/* ------------ SETUP ------------ */
void setup() {
  Serial.begin(9600);
  dht.begin();
  pinMode(BUZZER_PIN, OUTPUT);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("OLED Not Found");
    while (true);
  }

  display.clearDisplay();
  display.setTextColor(WHITE);
}

/* ------------ LOOP ------------ */
void loop() {

  float temperature = dht.readTemperature();
  float humidity    = dht.readHumidity();
  int gasValue      = analogRead(GAS_PIN);
  int soilRaw       = analogRead(SOIL_PIN);
  int moisture      = getSoilPercent(soilRaw);

  if (isnan(temperature) || isnan(humidity)) return;

  int healthScore = calculateHealthScore(
                      temperature,
                      humidity,
                      gasValue,
                      moisture
                    );

  String status = getStatus(healthScore);

  // Buzzer control
  if (status == "DANGER")
    digitalWrite(BUZZER_PIN, HIGH);
  else
    digitalWrite(BUZZER_PIN, LOW);

  // Auto page switch every 2 sec
  if (millis() - lastSwitch > 2000) {
    showMainPage = !showMainPage;
    lastSwitch = millis();
  }

  if (showMainPage)
    displayMain(temperature, humidity, gasValue, moisture, status);
  else
    displayInfo(healthScore, status);
}

/* ------------ FUNCTIONS ------------ */

int getSoilPercent(int raw) {
  int percent = map(raw, 4095, 1500, 0, 100);
  return constrain(percent, 0, 100);
}

int calculateHealthScore(float t, float h, int gas, int moist) {
  int score = 0;

  if (t >= TEMP_MIN && t <= TEMP_MAX) score += 25;
  if (h >= HUM_MIN && h <= HUM_MAX) score += 25;
  if (gas < GAS_LIMIT) score += 25;
  if (moist >= MOIST_MIN && moist <= MOIST_MAX) score += 25;

  return score;
}

String getStatus(int score) {
  if (score >= 80) return "SAFE";
  else if (score >= 50) return "WARNING";
  else return "DANGER";
}

void displayMain(float t, float h, int gas, int moist, String status) {

  display.clearDisplay();
  display.setTextSize(1);

  display.setCursor(0,0);
  display.print("T:");
  display.print(t,1);
  display.print("C  H:");
  display.print(h,0);
  display.print("%");

  display.setCursor(0,16);
  display.print("G:");
  display.print(gas);
  display.print("  M:");
  display.print(moist);
  display.print("%");

  display.setCursor(0,32);
  display.print("STATUS:");
  display.print(status);

  display.display();
}

void displayInfo(int score, String status) {

  display.clearDisplay();
  display.setTextSize(1);

  display.setCursor(0,0);
  display.print("HEALTH SCORE:");
  display.print(score);

  display.setCursor(0,20);
  if (status == "SAFE")
    display.print("ACTION: NONE");
  else if (status == "WARNING")
    display.print("ACTION: CHECK");
  else
    display.print("ACTION: IMMEDIATE!");

  display.display();
}