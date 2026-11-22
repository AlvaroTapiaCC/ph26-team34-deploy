import os

# Las pruebas no mandan tokens: los de un backend/.env local no deben exigirse aquí.
# load_dotenv no pisa variables ya definidas, así que basta con dejarlas vacías antes de importar la app.
for nombre in ("ADMIN_TOKEN", "CREW_TOKEN", "SIM_TOKEN"):
    os.environ[nombre] = ""
