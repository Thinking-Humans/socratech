import marimo

__generated_with = "0.25.2"
app = marimo.App()


@app.cell(hide_code=True)
def _():
    import marimo as mo

    return (mo,)


@app.cell(hide_code=True)
def cell_f00000000001(mo):
    mo.md(r"""
    # Spectral graphs

    Triple "\"" quotes, a backslash \ and braces {x} — λ → ∞ 🧠
    """)
    return


@app.cell(hide_code=True)
def cell_f00000000002(mo):
    mo.md(r"""
    Show that $L = D - A$ is PSD.

    $$x^\top L x = \sum_{(i,j)} (x_i - x_j)^2$$
    """)
    return


@app.cell
def cell_f00000000003():
    import numpy as np
    import networkx as nx

    return np, nx


@app.cell
def cell_f00000000004(nx):
    alpha_long_name, beta_long_name, gamma_long_name, delta_long_name = 1, 2, 3, 4
    G = nx.path_graph(4)
    L = nx.laplacian_matrix(G).toarray()
    return L, alpha_long_name, beta_long_name, delta_long_name, gamma_long_name


@app.cell
def cell_f00000000005(
    L,
    alpha_long_name,
    beta_long_name,
    delta_long_name,
    gamma_long_name,
    np,
):
    print(alpha_long_name + beta_long_name + gamma_long_name + delta_long_name, np.linalg.eigvalsh(L))
    summary = '''a
    """b"""
    '''
    return


@app.cell(hide_code=True)
def cell_f00000000006(mo):
    mo.md(r"""
    ````cpp
    #include <cstdio>
    int main() { std::puts("```"); }
    ````
    """)
    return


@app.cell(hide_code=True)
def cell_f00000000007(mo):
    _prompt = r"""
    Why is the Fiedler vector useful?
    """
    _answer = r"""
    It splits the graph: sign of $v_2$ gives a cut.

    ```python
    np.sign(v2)
    ```
    """
    mo.vstack([mo.callout(mo.md(_prompt), kind="info"), mo.md(_answer)])
    return


@app.cell(hide_code=True)
def cell_f00000000008(mo):
    _prompt = """
    Not answered yet ''' and \"\"\"
    """
    mo.callout(mo.md(_prompt), kind="info")
    return


@app.cell(hide_code=True)
def cell_f00000000009(mo):
    mo.md(r"""
    private: ask about Cheeger later
    """)
    return


@app.cell(hide_code=True)
def cell_f0000000000a(mo):
    mo.md(r"""
    Each edge contributes a square.
    """)
    return


@app.cell(hide_code=True)
def cell_f0000000000b(mo):
    mo.md(r"""
    **Pass.**
    """)
    return


if __name__ == "__main__":
    app.run()
